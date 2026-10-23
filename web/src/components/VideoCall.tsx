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

/** `listenOnly` joins with the microphone muted and the camera off (watching an AI interview). */
export function VideoCall({ seat, otherName, onLeave, listenOnly, unmuteSignal }: {
  seat: CallSeat; otherName: string; onLeave?: () => void; listenOnly?: boolean; unmuteSignal?: boolean;
}) {
  const local = useRef<HTMLVideoElement>(null);
  const remote = useRef<HTMLVideoElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const session = useRef<MeetingSession>();
  const [status, setStatus] = useState<'connecting' | 'waiting' | 'live' | 'ended' | 'error'>('connecting');
  const [error, setError] = useState<string>();
  const [muted, setMuted] = useState(!!listenOnly);
  const [cameraOn, setCameraOn] = useState(!listenOnly);
  const [remoteVideo, setRemoteVideo] = useState(false);
  const [notice, setNotice] = useState<string>();
  const devicesOn = useRef(false);

  /** Microphone and camera, each on its own: a missing or busy one never stops the call. */
  const startDevices = async (): Promise<boolean> => {
    const av = session.current?.audioVideo;
    if (!av) return false;
    if (devicesOn.current) return true;
    let mic = false;
    let cam = false;
    try {
      const mics = await av.listAudioInputDevices();
      if (mics[0]) { await av.startAudioInput(mics[0].deviceId); mic = true; }
    } catch { /* no microphone */ }
    try {
      const cams = await av.listVideoInputDevices();
      if (cams[0]) { await av.startVideoInput(cams[0].deviceId); cam = true; }
    } catch { /* no camera */ }
    devicesOn.current = mic || cam;
    setNotice(mic && cam ? undefined : !mic && !cam
      ? 'Your camera and microphone aren’t available (another tab or app may be using them). Close it and try again.'
      : !mic ? 'Your microphone isn’t available.' : 'Your camera isn’t available, so you’re on audio only.');
    return devicesOn.current;
  };

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
        // Watching needs no camera or microphone: they only start when you speak (or take over).
        const ready = listenOnly ? false : await startDevices();
        if (audio.current) await av.bindAudioElement(audio.current);
        av.start();
        if (listenOnly || !ready) av.realtimeMuteLocalAudio();
        else av.startLocalVideoTile();
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

  // Taking over an AI interview turns the microphone and camera on; handing back mutes again.
  useEffect(() => {
    const av = session.current?.audioVideo;
    if (!av || unmuteSignal === undefined) return;
    if (unmuteSignal) {
      startDevices().then((ok) => {
        if (!ok) return;
        av.realtimeUnmuteLocalAudio();
        av.startLocalVideoTile();
        setMuted(false);
        setCameraOn(true);
      });
    } else {
      av.realtimeMuteLocalAudio();
      av.stopLocalVideoTile();
      setMuted(true);
      setCameraOn(false);
    }
  }, [unmuteSignal]);

  const toggleMute = async () => {
    const av = session.current?.audioVideo;
    if (!av) return;
    if (muted && !(await startDevices())) return;
    if (muted) av.realtimeUnmuteLocalAudio();
    else av.realtimeMuteLocalAudio();
    setMuted(!muted);
  };
  const toggleCamera = async () => {
    const av = session.current?.audioVideo;
    if (!av) return;
    if (!cameraOn && !(await startDevices())) return;
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
      {notice && !error && <p className="small muted" style={{ marginTop: 8 }}>{notice}</p>}
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
