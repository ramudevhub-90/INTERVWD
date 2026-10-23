import { useEffect, useRef, useState } from 'react';
import {
  ConsoleLogger,
  DefaultDeviceController,
  DefaultMeetingSession,
  LogLevel,
  MeetingSessionConfiguration,
} from 'amazon-chime-sdk-js';
import type { AudioVideoObserver, MeetingSession, VideoTileState } from 'amazon-chime-sdk-js';
import { Icon } from './Icon';

// One video call seat on the Amazon Chime SDK: the browser joins the meeting the server created
// for this interview, with this person's attendee token. Two tiles (you and them), mute, camera, leave.

export interface CallSeat {
  meeting: unknown;
  attendee: unknown;
}

export function VideoCall({ seat, otherName, onLeave }: { seat: CallSeat; otherName: string; onLeave?: () => void }) {
  const local = useRef<HTMLVideoElement>(null);
  const remote = useRef<HTMLVideoElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const session = useRef<MeetingSession>();
  const [status, setStatus] = useState<'connecting' | 'waiting' | 'live' | 'ended' | 'error'>('connecting');
  const [error, setError] = useState<string>();
  const [muted, setMuted] = useState(false);
  const [cameraOn, setCameraOn] = useState(true);
  const [remoteVideo, setRemoteVideo] = useState(false);

  useEffect(() => {
    let stopped = false;
    const logger = new ConsoleLogger('intervwd-call', LogLevel.WARN);
    const devices = new DefaultDeviceController(logger);
    const s = new DefaultMeetingSession(new MeetingSessionConfiguration(seat.meeting, seat.attendee), logger, devices);
    session.current = s;
    const av = s.audioVideo;
    const me = (seat.attendee as { AttendeeId: string }).AttendeeId;

    const observer: AudioVideoObserver = {
      videoTileDidUpdate: (tile: VideoTileState) => {
        if (!tile.boundAttendeeId || tile.tileId == null) return;
        if (tile.localTile && local.current) av.bindVideoElement(tile.tileId, local.current);
        else if (!tile.localTile && remote.current) {
          av.bindVideoElement(tile.tileId, remote.current);
          setRemoteVideo(true);
        }
      },
      videoTileWasRemoved: () => setRemoteVideo(false),
      audioVideoDidStop: () => !stopped && setStatus('ended'),
    };
    av.addObserver(observer);
    av.realtimeSubscribeToAttendeeIdPresence((id, present) => {
      if (id !== me && !id.includes('#content')) setStatus(present ? 'live' : 'waiting');
    });

    (async () => {
      try {
        const mics = await av.listAudioInputDevices();
        if (mics[0]) await av.startAudioInput(mics[0].deviceId);
        const cams = await av.listVideoInputDevices();
        if (cams[0]) await av.startVideoInput(cams[0].deviceId);
        if (audio.current) await av.bindAudioElement(audio.current);
        av.start();
        if (cams[0]) av.startLocalVideoTile();
        if (!stopped) setStatus((st) => (st === 'connecting' ? 'waiting' : st));
      } catch (e) {
        setError((e as Error).message || 'Allow the camera and microphone to join the call.');
        setStatus('error');
      }
    })();

    return () => {
      stopped = true;
      av.removeObserver(observer);
      av.stopLocalVideoTile();
      av.stop();
      av.stopVideoInput().catch(() => undefined);
      av.stopAudioInput().catch(() => undefined);
    };
  }, [seat]);

  const toggleMute = () => {
    const av = session.current?.audioVideo;
    if (!av) return;
    if (muted) av.realtimeUnmuteLocalAudio();
    else av.realtimeMuteLocalAudio();
    setMuted(!muted);
  };
  const toggleCamera = () => {
    const av = session.current?.audioVideo;
    if (!av) return;
    if (cameraOn) av.stopLocalVideoTile();
    else av.startLocalVideoTile();
    setCameraOn(!cameraOn);
  };
  const leave = () => {
    session.current?.audioVideo.stop();
    setStatus('ended');
    onLeave?.();
  };

  return (
    <div className="call">
      <div className="call-stage">
        <video ref={remote} autoPlay playsInline className={remoteVideo ? '' : 'hidden'} />
        {!remoteVideo && (
          <div className="call-wait">
            <div className="avatar" style={{ width: 64, height: 64, fontSize: 20 }}>{otherName.split(' ').map((p) => p[0]).slice(0, 2).join('')}</div>
            <p>{status === 'live' ? `${otherName} joined with their camera off` : status === 'ended' ? 'You left the call' : status === 'error' ? 'Couldn’t join' : `Waiting for ${otherName} to join…`}</p>
          </div>
        )}
        <video ref={local} autoPlay muted playsInline className={`call-self ${cameraOn ? '' : 'hidden'}`} />
        <span className={`badge ${status === 'live' ? 'badge-success' : ''} call-status`}>{status === 'live' ? 'Live' : status === 'connecting' ? 'Connecting…' : status === 'waiting' ? 'Waiting' : status === 'ended' ? 'Ended' : 'Error'}</span>
      </div>
      <audio ref={audio} />
      {error && <p className="error">{error}</p>}
      {status !== 'ended' && (
        <div className="row" style={{ justifyContent: 'center', marginTop: 12 }}>
          <button className="btn" onClick={toggleMute} aria-label={muted ? 'Unmute' : 'Mute'}><Icon name={muted ? 'micOff' : 'mic'} /> {muted ? 'Unmute' : 'Mute'}</button>
          <button className="btn" onClick={toggleCamera} aria-label={cameraOn ? 'Turn camera off' : 'Turn camera on'}><Icon name="camera" /> {cameraOn ? 'Camera off' : 'Camera on'}</button>
          <button className="btn btn-danger" onClick={leave}><Icon name="x" /> Leave</button>
        </div>
      )}
      <p className="faint" style={{ textAlign: 'center', marginTop: 8 }}>Video call by Intervwd on Amazon Chime SDK. Not recorded.</p>
    </div>
  );
}
