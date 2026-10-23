import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import type { CheckIn } from '../api/types';
import { Icon } from '../components/Icon';
import { Loading, useLoad, when } from '../lib/util';
import { canListen, listen, speak, stopSpeaking } from '../lib/speech';
import { EchoSession } from './EchoInterview';

// The company's own Echo Shows on a hiring day (simulated until Alexa+ gives skills the camera):
//   Reception  /kiosk/<token>              "Alexa, I'm here for my interview" → name → face check → room
//   Room       /kiosk/<token>/room/<name>  waits for its next candidate, runs the voice interview, resets
// The kiosk link is a secret HR creates in Settings; it only works for that company.

const SILENCE_MS = 2200;
const RESET_MS = 12000;

function EchoFrame({ top, right, children, state, camera }: { top: string; right: string; children: React.ReactNode; state: string; camera?: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#05060c', padding: 16 }}>
      <div className="echo-show">
        <div className="echo-screen">
          <div className="echo-top"><span><Icon name="briefcase" size={14} /> {top}</span><span>{right}</span></div>
          <div className="echo-body">
            <div className="echo-text">{children}</div>
            {camera}
          </div>
          <div className={`echo-bar ${state}`} />
        </div>
        <div className="echo-base" />
      </div>
    </div>
  );
}

type Phase = 'idle' | 'name' | 'identity' | 'done';

export function ReceptionKiosk() {
  const { token = '' } = useParams();
  const { data: info, error } = useLoad(() => api.kiosk(token), [token]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [line, setLine] = useState('');
  const [sub, setSub] = useState('');
  const [heard, setHeard] = useState('');
  const [typed, setTyped] = useState('');
  const [state, setState] = useState<'idle' | 'speaking' | 'listening' | 'thinking'>('idle');
  const [room, setRoom] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number>();
  const [stream, setStream] = useState<MediaStream>();
  const video = useRef<HTMLVideoElement>(null);
  const listener = useRef<{ stop(): void }>();
  const busy = useRef(false);

  useEffect(() => {
    navigator.mediaDevices?.getUserMedia({ video: { width: 640, height: 480 }, audio: true }).then(setStream).catch(() => setSub('Allow the camera and microphone for check-in.'));
    return () => {
      listener.current?.stop();
      stopSpeaking();
    };
  }, []);
  useEffect(() => () => stream?.getTracks().forEach((t) => t.stop()), [stream]);
  useEffect(() => {
    if (video.current && stream) video.current.srcObject = stream;
  }, [stream, phase]);

  const say = useCallback(async (text: string) => {
    listener.current?.stop();
    setState('speaking');
    setLine(text);
    await speak(text);
    setState('idle');
  }, []);

  const hear = useCallback(() => new Promise<string>((resolve) => {
    let text = '';
    let last = Date.now();
    setHeard('');
    setState('listening');
    listener.current = listen((t) => {
      text = t;
      last = Date.now();
      setHeard(t);
    }, () => undefined);
    const timer = setInterval(() => {
      if (text.trim() && Date.now() - last > SILENCE_MS) {
        clearInterval(timer);
        listener.current?.stop();
        setState('thinking');
        resolve(text.trim());
      }
    }, 250);
  }), []);

  const reset = useCallback(() => {
    busy.current = false;
    setPhase('idle');
    setRoom(null);
    setSub('');
    setHeard('');
    setTyped('');
    setLine('');
  }, []);

  const frame = () => new Promise<Blob | null>((resolve) => {
    const v = video.current;
    if (!v || !v.videoWidth) return resolve(null);
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d')!.drawImage(v, 0, 0);
    c.toBlob(resolve, 'image/jpeg', 0.9);
  });

  /** From "I'm here" to "Please go to Room 1". `name` comes from typing; otherwise Alexa asks. */
  const checkIn = useCallback(async (name?: string) => {
    if (busy.current || !info) return;
    busy.current = true;
    setPhase('name');
    let found: CheckIn | undefined;
    for (let tries = 0; tries < 3 && !found; tries++) {
      let said = name;
      if (!said) {
        await say(tries === 0 ? `Welcome to ${info.orgName}! What's your name?` : 'Could you say your full name?');
        said = canListen ? await hear() : undefined;
        if (!said) break;
      }
      setState('thinking');
      try {
        found = await api.kioskCheckin(token, said);
      } catch (e) {
        await say((e as Error).message);
        name = undefined;
      }
    }
    if (!found) {
      setTimeout(reset, 6000);
      return;
    }
    await say(`Hi ${found.firstName}. You're here for ${found.jobTitle}, ${found.roundName.split(' · ')[0]}, at ${when(found.slotStart, { date: false })}.`);
    if (found.identityRequired && !['matched', 'approved'].includes(found.identityStatus)) {
      setPhase('identity');
      await say('Before you go in, I need to check it’s you. Please look at the camera.');
      let ok = false;
      for (let tries = 0; tries < 3 && !ok; tries++) {
        for (let n = 3; n > 0; n--) {
          setCountdown(n);
          await new Promise((r) => setTimeout(r, 900));
        }
        setCountdown(undefined);
        setState('thinking');
        setLine('Checking…');
        const img = await frame();
        const res = img ? await api.verifyIdentity(found.interviewId, img).catch((e: Error) => ({ status: 'pending' as const, message: e.message })) : { status: 'pending' as const, message: 'The camera isn’t ready.' };
        if (['matched', 'approved', 'not_required'].includes(res.status)) ok = true;
        else if (res.status === 'locked') {
          await say("I couldn't confirm it's you, so I've asked the team to come and check. Please take a seat.");
          setTimeout(reset, RESET_MS);
          return;
        } else await say(`${res.message ?? "That didn't match."} Let's try again. Face the light.`);
      }
      if (!ok) {
        setTimeout(reset, RESET_MS);
        return;
      }
      await say("Thanks, that's you.");
    }
    setState('thinking');
    try {
      const out = await api.kioskArrive(token, found.interviewId);
      setPhase('done');
      setRoom(out.room);
      await say(out.message);
    } catch (e) {
      await say((e as Error).message);
    }
    setTimeout(reset, RESET_MS);
  }, [hear, info, reset, say, token]);

  // "Alexa, I'm here for my interview."
  useEffect(() => {
    if (phase !== 'idle' || !info || !stream || !canListen) return;
    const l = listen((t) => {
      if (/\b(alexa|here|interview|check in|arrived)\b/i.test(t)) {
        l.stop();
        checkIn();
      }
    }, () => undefined);
    return () => l.stop();
  }, [phase, info, stream, checkIn]);

  if (!info) return <div className="centered"><div className="narrow"><Loading error={error} /></div></div>;

  return (
    <EchoFrame top={`${info.orgName} · Reception`} right={new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })} state={state}
      camera={phase === 'identity' || phase === 'done' ? (
        <div className={`echo-cam ${phase === 'identity' ? 'big' : ''}`}>
          {stream ? <video ref={video} autoPlay muted playsInline /> : <Icon name="camera" size={28} />}
          {countdown && <span className="echo-count">{countdown}</span>}
          {phase === 'identity' && <span className="echo-frame" />}
        </div>
      ) : <video ref={video} autoPlay muted playsInline style={{ display: 'none' }} />}>
      {phase === 'idle' ? (
        <>
          <p className="echo-sub">Here for an interview?</p>
          <p className="echo-line">Say "Alexa, I'm here for my interview"</p>
          <form className="row" style={{ marginTop: 18, maxWidth: 420 }} onSubmit={(e) => { e.preventDefault(); if (typed.trim()) checkIn(typed.trim()); }}>
            <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Or type your name" aria-label="Your name"
              style={{ background: '#161a2b', borderColor: '#2a3049', color: '#eef0f8' }} />
            <button className="btn btn-primary" disabled={!stream}>Check in</button>
          </form>
          {sub && <p className="echo-sub">{sub}</p>}
        </>
      ) : phase === 'done' && room ? (
        <>
          <p className="echo-sub">{line}</p>
          <p className="echo-line" style={{ fontSize: 'clamp(40px, 7vw, 72px)' }}>{room}</p>
        </>
      ) : (
        <>
          <p className="echo-line">{line}</p>
          {state === 'listening' && <p className="echo-heard">{heard || 'Listening…'}</p>}
          {sub && <p className="echo-sub">{sub}</p>}
        </>
      )}
    </EchoFrame>
  );
}

export function RoomKiosk() {
  const { token = '', room = '' } = useParams();
  const [now, setNow] = useState<{ interviewId: string | null; orgName: string; firstName?: string }>();
  const [error, setError] = useState<string>();
  const [active, setActive] = useState<string | null>(null);
  // Browsers only play sound after a tap, and nobody taps a room's Echo Show during an interview:
  // whoever sets the room up taps once when switching it on.
  const [armed, setArmed] = useState(false);

  // Check for the next candidate every few seconds while the room is free.
  useEffect(() => {
    if (active) return;
    let live = true;
    const poll = () => api.kioskRoom(token, room).then((r) => {
      if (!live) return;
      setNow(r);
      if (r.interviewId) setActive(r.interviewId);
    }).catch((e: Error) => live && setError(e.message));
    poll();
    const t = setInterval(poll, 4000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [token, room, active]);

  if (!armed) {
    return (
      <EchoFrame top={`${now?.orgName ?? 'Interview room'} · ${room}`} right="Set up" state="idle">
        <p className="echo-sub">{room}</p>
        <p className="echo-line">Tap once to switch on this interview room</p>
        <button className="btn btn-primary" style={{ marginTop: 18 }} onClick={() => { speak('This room is ready.'); setArmed(true); }}>Start this room</button>
        <p className="echo-sub">After this, it runs by itself: candidates come here from reception.</p>
      </EchoFrame>
    );
  }
  if (active) return <EchoSession key={active} id={active} room={room} onFinished={() => setActive(null)} />;
  if (!now) return <div className="centered"><div className="narrow"><Loading error={error} /></div></div>;
  return (
    <EchoFrame top={`${now.orgName} · ${room}`} right="Interview room" state="idle">
      <p className="echo-sub">{room}</p>
      <p className="echo-line">Waiting for the next candidate</p>
      <p className="echo-sub">Reception sends people here after they check in with Alexa.</p>
    </EchoFrame>
  );
}
