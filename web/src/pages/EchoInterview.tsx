import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { api } from '../api';
import type { InterviewStep } from '../api/types';
import { Icon } from '../components/Icon';
import { Loading, possessive, useLoad } from '../lib/util';
import { canListen, listen, speak, stopSpeaking } from '../lib/speech';

// How Intervwd would run on an Echo Show with Alexa+: hands-free, camera on, voice only.
// "Alexa, start my interview" → identity check on the Echo's camera → questions by voice, answers
// end after a pause (no buttons) → "any questions for us?" → goodbye. Built as a simulator because
// Alexa+ doesn't yet give skills or MCP servers the camera; this is the experience we're proposing.

const SILENCE_MS = 3200; // an answer ends after this much quiet, as Alexa does
const WAKE = /\b(alexa|start|begin|ready)\b/i;

type Phase = 'wake' | 'identity' | 'interview' | 'done' | 'blocked';

/** The candidate's own Echo Show interview (simulated), from their interview link. */
export function EchoInterview() {
  const { id = '' } = useParams();
  return <EchoSession id={id} />;
}

/**
 * One voice interview on an Echo Show screen. `room` marks an office interview room: the session
 * starts by itself (the candidate was checked in at reception) and calls `onFinished` when done,
 * so the room's screen can wait for the next person.
 */
export function EchoSession({ id, room, onFinished }: { id: string; room?: string; onFinished?: () => void }) {
  const { data, error } = useLoad(() => api.room(id), [id]);
  const [phase, setPhase] = useState<Phase>('wake');
  const [line, setLine] = useState('Say "Alexa, start my interview"');
  const [sub, setSub] = useState('');
  const [heard, setHeard] = useState('');
  const [state, setState] = useState<'idle' | 'speaking' | 'listening' | 'thinking'>('idle');
  const [countdown, setCountdown] = useState<number>();
  const [progress, setProgress] = useState<InterviewStep['progress']>();
  const [stream, setStream] = useState<MediaStream>();
  const video = useRef<HTMLVideoElement>(null);
  const listener = useRef<{ stop(): void }>();
  const lastChange = useRef(0);
  const answerRef = useRef('');
  const typedDone = useRef<(text: string) => void>();
  const [typed, setTyped] = useState('');
  const live = useRef(true);

  useEffect(() => {
    navigator.mediaDevices?.getUserMedia({ video: { width: 640, height: 480 }, audio: true }).then(setStream).catch(() => setSub('Allow the camera and microphone to start.'));
    return () => {
      live.current = false;
      listener.current?.stop();
      stopSpeaking();
    };
  }, []);
  useEffect(() => {
    if (video.current && stream) video.current.srcObject = stream;
  }, [stream, phase]);
  useEffect(() => () => stream?.getTracks().forEach((t) => t.stop()), [stream]);

  const say = useCallback(async (text: string, caption?: string) => {
    listener.current?.stop();
    setState('speaking');
    setLine(caption ?? text);
    await speak(text);
    if (live.current) setState('idle');
  }, []);

  /** Listens until the speaker pauses, then resolves with what they said. */
  /** Listens until the speaker pauses; a typed answer (for noisy rooms or anyone who can't speak) also counts. */
  const hear = useCallback(() => new Promise<string>((resolve) => {
    answerRef.current = '';
    setHeard('');
    setTyped('');
    setState('listening');
    lastChange.current = Date.now();
    typedDone.current = (text: string) => {
      clearInterval(timer);
      listener.current?.stop();
      setState('thinking');
      resolve(text);
    };
    listener.current = listen((t) => {
      answerRef.current = t;
      setHeard(t);
      lastChange.current = Date.now();
    }, (m) => setSub(m));
    const timer = setInterval(() => {
      if (answerRef.current.trim() && Date.now() - lastChange.current > SILENCE_MS) {
        clearInterval(timer);
        listener.current?.stop();
        setState('thinking');
        resolve(answerRef.current.trim());
      }
    }, 300);
  }), []);

  const frame = () => new Promise<Blob | null>((resolve) => {
    const v = video.current;
    if (!v || !v.videoWidth) return resolve(null);
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d')!.drawImage(v, 0, 0);
    c.toBlob(resolve, 'image/jpeg', 0.9);
  });

  const identity = useCallback(async (): Promise<boolean> => {
    setPhase('identity');
    await say(`Hi ${data!.candidateName.split(' ')[0]}. Before we begin, I need to check it's you. Please look at the camera.`);
    for (let tries = 0; tries < 3; tries++) {
      for (let n = 3; n > 0; n--) {
        setCountdown(n);
        await new Promise((r) => setTimeout(r, 900));
      }
      setCountdown(undefined);
      setState('thinking');
      setLine('Checking…');
      const img = await frame();
      const res = img ? await api.verifyIdentity(id, img).catch((e: Error) => ({ status: 'pending' as const, message: e.message })) : { status: 'pending' as const, message: 'The camera isn’t ready.' };
      if (res.status === 'matched' || res.status === 'approved' || res.status === 'not_required') {
        await say("Thanks, that's you.");
        return true;
      }
      if (res.status === 'locked') {
        setPhase('blocked');
        await say("I couldn't confirm it's you, so I've asked the team to check. They'll be in touch.");
        return false;
      }
      await say(`${res.message ?? "That didn't match."} Let's try again. Face the light and look at the camera.`);
    }
    return false;
  }, [data, id, say]);

  const run = useCallback(async () => {
    if (!data) return;
    if (data.candidateStatus === 'pending_approval') {
      setPhase('blocked');
      return say(`${data.orgName} hasn't approved your profile yet. I'll let you know when they do.`);
    }
    const needs = data.identity?.required && !['matched', 'approved'].includes(data.identity.status);
    if (needs && !(await identity())) return;
    setPhase('interview');
    setState('thinking');
    let step = await api.startInterview(id);
    for (;;) {
      if (!live.current) return;
      setProgress(step.progress);
      for (const t of step.turns) await say(t.text);
      if (step.done) {
        setPhase('done');
        setLine(room ? `Thank you, ${data.candidateName.split(' ')[0]}. You can leave the room now.` : 'Interview complete');
        setSub(`${possessive(data.orgName)} team will be in touch by email.`);
        if (onFinished) setTimeout(onFinished, 12000);
        return;
      }
      const ans = await hear();
      setSub('');
      step = await api.answer(id, ans);
    }
  }, [data, hear, id, identity, say]);

  // Snapshots during the interview, as in the browser room: the team can see who took it, and the
  // server compares each with the profile photo when the identity check is on.
  useEffect(() => {
    if (phase !== 'interview') return;
    const shot = () => {
      const v = video.current;
      if (!v || !v.videoWidth) return;
      const c = document.createElement('canvas');
      c.width = 320;
      c.height = 240;
      c.getContext('2d')!.drawImage(v, 0, 0, 320, 240);
      c.toBlob((b) => b && api.snapshot(id, b).catch(() => undefined), 'image/jpeg', 0.7);
    };
    const first = setTimeout(shot, 5000);
    const every = setInterval(shot, 90_000);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, [phase, id]);

  // In an office room the candidate is already checked in: begin as soon as the camera is ready.
  const started = useRef(false);
  useEffect(() => {
    if (!room || !data || !stream || started.current) return;
    started.current = true;
    setLine(`Welcome, ${data.candidateName.split(' ')[0]}. Take a seat; we'll begin in a moment.`);
    const t = setTimeout(run, 3500);
    return () => clearTimeout(t);
  }, [room, data, stream, run]);

  // Wake word: "Alexa, start my interview".
  useEffect(() => {
    if (room || phase !== 'wake' || !data || !stream || !canListen) return;
    const l = listen((t) => {
      if (WAKE.test(t)) {
        l.stop();
        run();
      }
    }, () => undefined);
    return () => l.stop();
  }, [phase, data, stream, run]);

  if (!data) return <div className="centered"><div className="narrow"><Loading error={error} /></div></div>;
  if (data.mode === 'human') return <Navigate to={`/interview/${id}`} replace />; // a video call with a person, not Alexa

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#05060c', padding: 16 }}>
      <div className="echo-show">
        <div className="echo-screen">
          <div className="echo-top">
            <span><Icon name="briefcase" size={14} /> {data.orgName} · {data.job.title}</span>
            <span>{progress && phase === 'interview' ? `Question ${progress.question} of ${progress.of}` : room ? `${room} · ${data.round.name}` : data.round.name}</span>
          </div>
          <div className="echo-body">
            <div className="echo-text">
              <p className="echo-line">{line}</p>
              {state === 'listening' && <p className="echo-heard">{heard || 'Listening…'}</p>}
              {state === 'listening' && (
                <form className="row" style={{ marginTop: 14, maxWidth: 520 }} onSubmit={(e) => { e.preventDefault(); if (typed.trim()) typedDone.current?.(typed.trim()); }}>
                  <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Or type your answer" aria-label="Type your answer"
                    style={{ background: '#161a2b', borderColor: '#2a3049', color: '#eef0f8' }} />
                  <button className="btn" disabled={!typed.trim()}>Send</button>
                </form>
              )}
              {sub && <p className="echo-sub">{sub}</p>}
              {phase === 'wake' && !room && (
                <button className="btn btn-primary" style={{ marginTop: 18 }} onClick={run} disabled={!stream}>
                  {stream ? (canListen ? 'Or tap to start' : 'Tap to start') : 'Waiting for camera'}
                </button>
              )}
            </div>
            <div className={`echo-cam ${phase === 'identity' ? 'big' : ''}`}>
              {stream ? <video ref={video} autoPlay muted playsInline /> : <Icon name="camera" size={28} />}
              {countdown && <span className="echo-count">{countdown}</span>}
              {phase === 'identity' && <span className="echo-frame" />}
            </div>
          </div>
          <div className={`echo-bar ${state}`} />
        </div>
        <div className="echo-base" />
      </div>
      {!room && <p className="faint" style={{ marginTop: 16, textAlign: 'center', maxWidth: 520 }}>
        Echo Show with Alexa+ (simulated). Alexa+ doesn't yet let skills use the camera, so this shows the experience we're proposing.{' '}
        <Link to={`/interview/${id}`}>Use the standard interview room instead</Link>
      </p>}
    </div>
  );
}
