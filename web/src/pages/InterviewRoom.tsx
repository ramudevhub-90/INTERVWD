import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import type { InterviewStep, Turn } from '../api/types';
import { Icon } from '../components/Icon';
import { PublicTop } from '../components/Shell';
import { Loading, useLoad } from '../lib/util';
import { canListen, listen, speak, stopSpeaking } from '../lib/speech';

const SNAPSHOT_EVERY_MS = 90_000;

type Stage = 'setup' | 'live' | 'done';
type Mode = 'speaking' | 'listening' | 'thinking' | 'idle';

export function InterviewRoom() {
  const { id = '' } = useParams();
  const { data, error } = useLoad(() => api.room(id), [id]);
  const [stage, setStage] = useState<Stage>('setup');
  const [mode, setMode] = useState<Mode>('idle');
  const [stream, setStream] = useState<MediaStream>();
  const [mediaError, setMediaError] = useState<string>();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [typing, setTyping] = useState(!canListen);
  const [progress, setProgress] = useState<InterviewStep['progress']>();
  const [err, setErr] = useState<string>();
  const video = useRef<HTMLVideoElement>(null);
  const listener = useRef<{ stop(): void }>();
  const log = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (data?.interview.status === 'completed') setStage('done');
  }, [data]);

  // Camera and microphone for the whole visit; released when leaving the page.
  useEffect(() => {
    if (stage === 'done') return;
    let live: MediaStream | undefined;
    navigator.mediaDevices?.getUserMedia({ video: { width: 640, height: 480 }, audio: true })
      .then((s) => {
        live = s;
        setStream(s);
      })
      .catch(() => setMediaError('Allow camera and microphone access in your browser to take the interview.'));
    return () => {
      live?.getTracks().forEach((t) => t.stop());
      listener.current?.stop();
      stopSpeaking();
    };
  }, [stage === 'done']); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (video.current && stream) video.current.srcObject = stream;
  }, [stream, stage]);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' });
  }, [turns, draft]);

  const snapshot = useCallback(() => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = 320;
    c.height = 240;
    const ctx = c.getContext('2d')!;
    ctx.translate(320, 0);
    ctx.scale(-1, 1); // match the mirrored preview
    ctx.drawImage(v, 0, 0, 320, 240);
    c.toBlob((b) => b && api.snapshot(id, b).catch(() => undefined), 'image/jpeg', 0.7);
  }, [id]);

  useEffect(() => {
    if (stage !== 'live') return;
    const first = setTimeout(snapshot, 4000);
    const every = setInterval(snapshot, SNAPSHOT_EVERY_MS);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, [stage, snapshot]);

  const startListening = useCallback(() => {
    setDraft('');
    if (typing) return setMode('idle');
    setMode('listening');
    listener.current = listen(setDraft, (m) => {
      setErr(m);
      setTyping(true);
      setMode('idle');
    });
  }, [typing]);

  const play = useCallback(async (step: InterviewStep) => {
    setProgress(step.progress);
    setTurns((t) => [...t, ...step.turns]);
    setMode('speaking');
    for (const t of step.turns) await speak(t.text);
    if (step.done) {
      setMode('idle');
      setStage('done');
      return;
    }
    startListening();
  }, [startListening]);

  const begin = async () => {
    setErr(undefined);
    setStage('live');
    setMode('thinking');
    try {
      const step = await api.startInterview(id);
      setTurns([]);
      await play(step);
    } catch (e) {
      setErr((e as Error).message);
      setMode('idle');
    }
  };

  const submit = async () => {
    const text = draft.trim();
    if (!text) return setErr(typing ? 'Type your answer first.' : "We didn't catch an answer yet. Speak, or switch to typing.");
    listener.current?.stop();
    setErr(undefined);
    setMode('thinking');
    setTurns((t) => [...t, { role: 'candidate', kind: 'answer', text, at: new Date().toISOString(), questionIndex: -1 }]);
    setDraft('');
    try {
      await play(await api.answer(id, text));
    } catch (e) {
      setErr((e as Error).message);
      setDraft(text);
      setMode('idle');
    }
  };

  const toggleTyping = () => {
    listener.current?.stop();
    const next = !typing;
    setTyping(next);
    if (next) return setMode('idle');
    setMode('listening');
    listener.current = listen(setDraft, (m) => {
      setErr(m);
      setTyping(true);
      setMode('idle');
    });
  };

  const repeat = async () => {
    const last = [...turns].reverse().find((t) => t.role === 'interviewer');
    if (!last) return;
    listener.current?.stop();
    setMode('speaking');
    await speak(last.text);
    startListening();
  };

  if (!data) {
    return (
      <>
        <PublicTop />
        <div className="centered"><div className="narrow"><Loading error={error} /></div></div>
      </>
    );
  }

  const current = [...turns].reverse().find((t) => t.role === 'interviewer');
  const header = (
    <div className="row between wrap" style={{ maxWidth: 1100, margin: '0 auto', padding: '0 24px 14px' }}>
      <div>
        <p className="faint">{data.orgName} · {data.job.title}</p>
        <h2>{data.round.name}</h2>
      </div>
      {progress && stage === 'live' && <span className="badge badge-accent">Question {progress.question} of {progress.of}</span>}
    </div>
  );

  if (stage === 'done') {
    return (
      <>
        <PublicTop />
        <div className="centered">
          <div className="card narrow" style={{ textAlign: 'center' }}>
            <div className="orb" style={{ margin: '0 auto 14px', background: 'var(--success)' }}><Icon name="check" size={26} /></div>
            <h2>Thank you, {data.candidateName.split(' ')[0]}</h2>
            <p className="muted" style={{ margin: '10px 0' }}>Your interview for {data.job.title} is complete. {data.orgName}'s team will review it and email you about next steps.</p>
            <p className="faint">You can close this window.</p>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <PublicTop right={<span className="faint row"><Icon name="shield" size={16} /> Recorded for {data.orgName}'s recruiters</span>} />
      {header}
      <div className="room">
        <div className="stack">
          <div className="video">
            {stream ? <video ref={video} autoPlay muted playsInline /> : <div className="stack" style={{ alignItems: 'center', gap: 8 }}><Icon name="camera" size={32} /><span className="small">{mediaError ?? 'Starting camera…'}</span></div>}
            {stream && <span className="tag badge badge-success"><Icon name="camera" size={13} /> Camera on</span>}
          </div>
          <div className="card card-flat" style={{ padding: '14px 16px' }}>
            <p className="small muted">A few snapshots are taken during the interview so the team can see who took it. There's no face recognition. Speak naturally; you can ask for a question to be repeated.</p>
          </div>
        </div>

        <div className="card stack" style={{ gap: 14 }}>
          {stage === 'setup' ? (
            <>
              <div className="row"><div className="orb"><Icon name="mic" size={24} /></div><div><h3>Before you start</h3><p className="faint">About {data.round.durationMin} minutes · {data.round.questions.length} questions with follow-ups</p></div></div>
              <ul className="small muted" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
                <li>Find a quiet place and look at the camera.</li>
                <li>The interviewer speaks each question. Answer out loud, then press <b>Finish answer</b>.</li>
                <li>Take your time. Use <b>Repeat</b> if you missed something.</li>
                {!canListen && <li>Your browser can't caption speech, so you'll type answers. Chrome or Edge lets you speak.</li>}
              </ul>
              <button className="btn btn-primary btn-lg" onClick={begin} disabled={!stream}>{stream ? 'Start interview' : 'Waiting for camera and microphone'}</button>
              {mediaError && (
                <>
                  <p className="error" style={{ marginTop: 0 }}>{mediaError}</p>
                  <button className="btn" onClick={() => { setTyping(true); begin(); }}>Continue without camera, typing answers</button>
                  <p className="faint">The recruiter will see that your camera was off.</p>
                </>
              )}
            </>
          ) : (
            <>
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <div className={`orb ${mode === 'speaking' ? 'speaking' : mode === 'listening' ? 'listening' : ''}`}>
                  <Icon name={mode === 'listening' ? 'mic' : mode === 'thinking' ? 'sparkle' : 'speaker'} size={24} />
                </div>
                <div style={{ flex: 1 }}>
                  <p className="faint" style={{ marginBottom: 4 }}>{mode === 'speaking' ? 'Interviewer is speaking' : mode === 'listening' ? 'Listening to your answer' : mode === 'thinking' ? 'Interviewer is thinking…' : 'Your turn'}</p>
                  <p className="question">{current?.text ?? '…'}</p>
                </div>
              </div>

              <div className="field" style={{ marginBottom: 0 }}>
                <span>{typing ? 'Your answer' : 'What we heard'}</span>
                <textarea rows={4} value={draft} readOnly={!typing && mode === 'listening'} onChange={(e) => { setDraft(e.target.value); setErr(undefined); }} placeholder={typing ? 'Type your answer' : mode === 'listening' ? 'Start speaking…' : ''} />
              </div>
              <div className="row wrap">
                <button className="btn btn-primary" onClick={submit} disabled={mode === 'speaking' || mode === 'thinking'}><Icon name="send" /> Finish answer</button>
                <button className="btn" onClick={repeat} disabled={mode === 'thinking'}><Icon name="repeat" /> Repeat</button>
                {canListen && (
                  <button className="btn btn-ghost" onClick={toggleTyping} disabled={mode === 'speaking' || mode === 'thinking'}>
                    <Icon name={typing ? 'mic' : 'keyboard'} /> {typing ? 'Speak instead' : 'Type instead'}
                  </button>
                )}
              </div>
              {err && <p className="error" style={{ marginTop: 0 }}>{err}</p>}

              <div className="divider" />
              <div className="transcript" ref={log}>
                {turns.slice(0, -1).map((t, i) => (
                  <div key={i} className={`bubble ${t.role === 'interviewer' ? 'ai' : 'me'}`}>{t.text}</div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
