/*
 * (C) Copyright 2014-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */
const NodeMediaServer = require('node-media-server').NodeMediaServer;
const path = require('path');
const url = require('url');
const cookieParser = require('cookie-parser');
const express = require('express');
const session = require('express-session');
const minimist = require('minimist');
const ws = require('ws');
const kurento = require('kurento-client');
const https = require('https');
const childProcess = require('child_process');
const spawn = childProcess.spawn;
const fs = require("fs");

const argv = minimist(process.argv.slice(2), {
    default: {
        as_uri: 'https://localhost:8443/',
        ws_uri: 'ws://localhost:8888/kurento'
    }
});

const options =
    {
        key: fs.readFileSync('keys/server.key'),
        cert: fs.readFileSync('keys/server.crt')
    };

let session_index = 0;

const app = express();

app.use(cookieParser());

const sessionHandler = session({
    secret: 'none',
    rolling: true,
    resave: true,
    saveUninitialized: true
});

app.use(sessionHandler);

/*
 * Definition of global variables.
 */
const sessions = {};
const candidatesQueue = {};
let kurentoClient = null;

/*
 * Server startup
 */
const asUrl = url.parse(argv.as_uri);
const port = asUrl.port;
const server = https.createServer(options, app).listen(port, () => {
    console.log('Kurento Tutorial started');
    console.log('Open ' + url.format(asUrl) + ' with a WebRTC capable browser');
});

const wss = new ws.Server({
    server: server,
    path: '/magicmirror'
});

/*
 * Management of WebSocket messages
 */
wss.on('connection', ws => {
    const request = ws.upgradeReq;
    const response = {
        writeHead: {}
    };
    let sessionId = null;

    sessionHandler(request, response, error => {
        sessionId = request.session.id;
        console.log('Connection received with sessionId ' + sessionId);
    });

    ws.on('error', error => {
        console.log('Connection ' + sessionId + ' error');
        stop(sessionId);
    });

    ws.on('close', error => {
        console.log('Connection ' + sessionId + ' closed');
        stop(sessionId);
    });

    ws.on('message', wsMessage => {
        const message = JSON.parse(wsMessage);
        console.log('Connection ' + sessionId + ' received message ', message);

        switch (message.id) {
            case 'start':
                sessionId = request.session.id;
                start(sessionId, ws, message.sdpOffer, function (error, sdpAnswer) {
                    if (error) {
                        return ws.send(JSON.stringify({
                            id: 'error',
                            message: error
                        }));
                    }
                    ws.send(JSON.stringify({
                        id: 'startResponse',
                        sdpAnswer: sdpAnswer
                    }));
                });
                break;

            case 'stop':
                stop(sessionId);
                break;

            case 'onIceCandidate':
                onIceCandidate(sessionId, message.candidate);
                break;

            default:
                ws.send(JSON.stringify({
                    id: 'error',
                    message: 'Invalid message ' + message
                }));
                break;
        }

    });
});

/*
 * Definition of functions
 */

// Recover kurentoClient for the first time.
function getKurentoClient(callback) {
    if (kurentoClient !== null) {
        return callback(null, kurentoClient);
    }

    kurento(argv.ws_uri, function(error, _kurentoClient) {
        if (error) {
            console.log("Could not find media server at address " + argv.ws_uri);
            return callback("Could not find media server at address" + argv.ws_uri
                + ". Exiting with error " + error);
        }

        kurentoClient = _kurentoClient;
        callback(null, kurentoClient);
    });
}

function start(sessionId, ws, sdpOffer, callback) {
    if (!sessionId) {
        return callback('Cannot use undefined sessionId');
    }

    getKurentoClient(function (error, kurentoClient) {
        if (error) {
            return callback(error);
        }

        kurentoClient.create('MediaPipeline', function (error, pipeline) {
            if (error) {
                return callback(error);
            }

            createMediaElements(pipeline, ws, function (error, webRtcEndpoint, rtpEndpoint) {
                if (error) {
                    pipeline.release();
                    return callback(error);
                }

                if (candidatesQueue[sessionId]) {
                    while (candidatesQueue[sessionId].length) {
                        var candidate = candidatesQueue[sessionId].shift();
                        webRtcEndpoint.addIceCandidate(candidate);
                    }
                }

                connectMediaElements(webRtcEndpoint, rtpEndpoint, function (error) {
                    if (error) {
                        pipeline.release();
                        return callback(error);
                    }

                    webRtcEndpoint.on('OnIceCandidate', function (event) {
                        var candidate = kurento.getComplexType('IceCandidate')(event.candidate);
                        ws.send(JSON.stringify({
                            id: 'iceCandidate',
                            candidate: candidate
                        }));
                    });

                    webRtcEndpoint.processOffer(sdpOffer, function (error, sdpAnswer) {
                        if (error) {
                            pipeline.release();
                            return callback(error);
                        }
                        console.log('my session id:', sessionId);
                        var streamPort = 55000 + (session_index * 2);
                        var audioPort = 49170 + (session_index * 2);
                        session_index++;    //change to next port
                        var streamIp = '127.0.0.1';//Test ip
                        generateSdpStreamConfig(streamIp, streamPort, audioPort, function (err, sdpRtpOfferString) {
                            if (err) {
                                return callback(error);
                            }
                            rtpEndpoint.processOffer(sdpRtpOfferString, function (error) {
                                if (error) {
                                    return callback(error);
                                }
                                console.log('start process on: rtp://' + streamIp + ':' + streamPort);
                                console.log('recv sdp answer:', sdpAnswer);
                                var ffmpeg_child = bindFFmpeg(streamIp, streamPort, sdpRtpOfferString, ws);
                                sessions[sessionId] = {
                                    'pipeline': pipeline,
                                    'webRtcEndpoint': webRtcEndpoint,
                                    'rtpEndpoint': rtpEndpoint,
                                    'ffmpeg_child_process': ffmpeg_child
                                };
                                return callback(null, sdpAnswer);
                            });
                        });
                        //no need to reply sdpanswer
                        //return callback(null, sdpAnswer);
                    });
                    webRtcEndpoint.gatherCandidates(function (error) {
                        if (error) {
                            return callback(error);
                        }
                    });
                });
            });
        });
    });
}

function createMediaElements(pipeline, ws, callback) {
    pipeline.create('WebRtcEndpoint', function (error, webRtcEndpoint) {
        if (error) {
            return callback(error);
        }

        webRtcEndpoint.setMinVideoRecvBandwidth(100);
        webRtcEndpoint.setMaxVideoRecvBandwidth(200);

        pipeline.create("RtpEndpoint", function (error, rtpEndpoint) {
            if (error) {
                console.log("Recorder problem");
                return callback(error);
            }
            callback(null, webRtcEndpoint, rtpEndpoint);
        });
    });
}

function generateSdpStreamConfig(nodeStreamIp, port, audioport, callback) {
    if (typeof nodeStreamIp === 'undefined'
        || nodeStreamIp === null
        || typeof port === 'undefined'
        || port === null) {
        return callback('nodeStreamIp and port for generating Sdp Must be setted');
    }
    var sdpRtpOfferString = 'v=0\n';
    sdpRtpOfferString += 'o=- 0 0 IN IP4 ' + nodeStreamIp + '\n';
    sdpRtpOfferString += 's=KMS\n';
    sdpRtpOfferString += 'c=IN IP4 ' + nodeStreamIp + '\n';
    sdpRtpOfferString += 't=0 0\n';
    sdpRtpOfferString += 'm=audio ' + audioport + ' RTP/AVP 97\n';
    sdpRtpOfferString += 'a=recvonly\n';
    sdpRtpOfferString += 'a=rtpmap:97 PCMU/8000\n';
    sdpRtpOfferString += 'a=fmtp:97 profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3;config=1508\n';
    sdpRtpOfferString += 'm=video ' + port + ' RTP/AVP 96\n';
    sdpRtpOfferString += 'a=rtpmap:96 H264/90000\n';
    sdpRtpOfferString += 'a=fmtp:96 packetization-mode=1\n';
    return callback(null, sdpRtpOfferString);
}

function connectMediaElements(webRtcEndpoint, rtpEndpoint, callback) {
    webRtcEndpoint.connect(rtpEndpoint, function (error) {
        if (error) {
            return callback(error);
        }
        //it will cause loop back
        //see https://groups.google.com/forum/?hl=IT#!searchin/kurento/rtpendpoint/kurento/CiN79QObJWQ/YS-uGhP7t9AJ

        /*rtpEndpoint.connect(webRtcEndpoint, function (error) {
            if (error) {
                return callback(error);
            }
            return callback(null);
        });*/

        return callback(null);
    });
}
/*
ffmpeg -protocol_whitelist "file,udp,rtp" -i 127.0.0.1_55000.sdp -vcodec copy -f flv rtmp://localhost/live/stream
*/
/*
SDP:
v=0
o=- 0 0 IN IP4 127.0.0.1
s=No Name
c=IN IP4 127.0.0.1
t=0 0
a=tool:libavformat 57.71.100
m=video 55000 RTP/AVP 96
b=AS:200
a=rtpmap:96 H264/90000
*/
function bindFFmpeg(streamip, streamport, sdpData, ws) {
    fs.writeFileSync(streamip + '_' + streamport + '.sdp', sdpData);
    var ffmpeg_args = [
        '-protocol_whitelist', 'file,udp,rtp',
        '-i', path.join(__dirname, streamip + '_' + streamport + '.sdp'),
        '-vcodec', 'copy',
        '-acodec', 'copy',
        '-f', 'flv',
        'rtmp://localhost/live/' + streamip + '_' + streamport
    ].concat();
    var child = spawn('ffmpeg', ffmpeg_args);
    console.log(ffmpeg_args);
    ws.send(JSON.stringify({
        id: 'rtmp',
        message: '/live/' + streamip + '_' + streamport
    }));
    //ignore stdout
    //this.child.stdout.on('data', this.emit.bind(this, 'data'));
    child.stderr.on('data', function (data) {
        var _len = data.length;
        var _str;
        if (data[_len - 1] == 13) {
            _str = data.toString().substring(0, _len - 1);
        } else {
            _str = data.toString();
        }
        ws.send(JSON.stringify({
            id: 'ffmpeg',
            message: _str
        }));
    });

    child.on('error', function (err) {
        if (err.code == 'ENOENT') {
            ws.send(JSON.stringify({
                id: 'ffmpeg',
                message: 'The server has not installed ffmpeg yet.'
            }));
        } else {
            ws.send(JSON.stringify({
                id: 'ffmpeg',
                message: err
            }));
        }
    });

    child.on('close', function (code) {
        if (code === 0) {
            ws.send(JSON.stringify({
                id: 'ffmpeg',
                message: streamip + '_' + streamport + ' closed'
            }));
        }
    });
    return child;
}

function stop(sessionId) {
    if (sessions[sessionId]) {
        var pipeline = sessions[sessionId].pipeline;
        console.info('Releasing pipeline');
        pipeline.release();
        var child_process = sessions[sessionId].ffmpeg_child_process;
        if (child_process) {
            console.info('Killing child process');
            child_process.kill();
            delete child_process;
        }
        delete sessions[sessionId];
        delete candidatesQueue[sessionId];
    }
}

function onIceCandidate(sessionId, _candidate) {
    var candidate = kurento.getComplexType('IceCandidate')(_candidate);

    if (sessions[sessionId]) {
        console.info('Sending candidate');
        var webRtcEndpoint = sessions[sessionId].webRtcEndpoint;
        webRtcEndpoint.addIceCandidate(candidate);
    }
    else {
        console.info('Queueing candidate');
        if (!candidatesQueue[sessionId]) {
            candidatesQueue[sessionId] = [];
        }
        candidatesQueue[sessionId].push(candidate);
    }
}

// Frontend
app.use(express.static(path.join(__dirname, 'static')));

// Node media server
const nms = new NodeMediaServer({
    rtmp: {
        port: 1935,
        chunk_size: 60000,
        gop_cache: true,
        ping: 60,
        ping_timeout: 30
    },
    http: {
        port: 8000,
        allow_origin: '*'
    }
});

nms.run();

nms.on('preConnect', (id, args) => {
    console.log('[NodeEvent on preConnect]', `id=${id} args=${JSON.stringify(args)}`);
});

nms.on('postConnect', (id, args) => {
    console.log('[NodeEvent on postConnect]', `id=${id} args=${JSON.stringify(args)}`);
});

nms.on('doneConnect', (id, args) => {
    console.log('[NodeEvent on doneConnect]', `id=${id} args=${JSON.stringify(args)}`);
});

nms.on('prePublish', (id, StreamPath, args) => {
    console.log('[NodeEvent on prePublish]', `id=${id} StreamPath=${StreamPath} args=${JSON.stringify(args)}`);
});

nms.on('postPublish', (id, StreamPath, args) => {
    console.log('[NodeEvent on postPublish]', `id=${id} StreamPath=${StreamPath} args=${JSON.stringify(args)}`);
});

nms.on('donePublish', (id, StreamPath, args) => {
    console.log('[NodeEvent on donePublish]', `id=${id} StreamPath=${StreamPath} args=${JSON.stringify(args)}`);
});

nms.on('prePlay', (id, StreamPath, args) => {
    console.log('[NodeEvent on prePlay]', `id=${id} StreamPath=${StreamPath} args=${JSON.stringify(args)}`);
});

nms.on('postPlay', (id, StreamPath, args) => {
    console.log('[NodeEvent on postPlay]', `id=${id} StreamPath=${StreamPath} args=${JSON.stringify(args)}`);
});

nms.on('donePlay', (id, StreamPath, args) => {
    console.log('[NodeEvent on donePlay]', `id=${id} StreamPath=${StreamPath} args=${JSON.stringify(args)}`);
});

// Error
process.on('uncaughtException', error => console.error(error));
