import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { Icon } from '../components/Icon';
import { canListen, listen, speak, stopSpeaking } from '../lib/speech';

// Practise with Alexa before the real interview: practice questions on the same skills (never the
// real ones), spoken coaching after each answer, nothing shared with the company.

interface Feedback {
  strength: string;
  improve: string;
  tip: string;
}

export function Practice() {
  const { id = '' } = useParams();
  const [intro, setIntro] = useState<{ intro: string; orgName: string; jobTitle: string }>();
  const [question, setQuestion] = useState<string | null>(null);
  const [progress, setProgress] = useState({ index: 1, of: 3 });
  const [feedback, setFeedback] = useState<Feedback>();
  const [answer, setAnswer] = useState('');
  const [state, setState] = useState<'idle' | 'speaking' | 'listening' | 'thinking'>('idle');
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string>();
  const listener = useRef<{ stop(): void }>();
  const live = useRef(true);

  useEffect(() => () => {
    live.current = false;
    listener.current?.stop();
    stopSpeaking();
  }, []);

  const say = useCallback(async (text: string) => {
    listener.current?.stop();
    setState('speaking');
    await speak(text);
    if (live.current) setState('idle');
  }, []);

  const startListening = useCallback(() => {
    if (!canListen) return;
    setAnswer('');
    setState('listening');
    listener.current = listen(setAnswer, (m) => setErr(m));
  }, []);

  const begin = async () => {
    setErr(undefined);
    setDone(false);
    setFeedback(undefined);
    setState('thinking');
    try {
      const s = await api.practiceStart(id);
      setIntro(s);
      setQuestion(s.question);
      setProgress({ index: s.index, of: s.of });
      await say(`${s.intro} First question. ${s.question}`);
    } catch (e) {
      setErr((e as Error).message);
      setState('idle');
    }
  };

  const submit = async () => {
    if (!answer.trim()) return setErr('Say or type an answer first.');
    listener.current?.stop();
    setErr(undefined);
    setState('thinking');
    try {
      const out = await api.practiceAnswer(id, answer);
      setFeedback(out.feedback);
      await say(`${out.feedback.strength} ${out.feedback.improve} Tip: ${out.feedback.tip}`);
      if (out.question) {
        setQuestion(out.question);
        setProgress({ index: out.index, of: out.of });
        setFeedback(undefined);
        setAnswer('');
        await say(`Next question. ${out.question}`);
      } else {
        setDone(true);
        await say("That's the end of practice. Well done. You can go again, or start your real interview when you're ready.");
      }
    } catch (e) {
      setErr((e as Error).message);
      setState('idle');
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#05060c', padding: 16 }}>
      <div className="echo-show">
        <div className="echo-screen">
          <div className="echo-top">
            <span><Icon name="sparkle" size={14} /> Practice{intro ? ` · ${intro.orgName} · ${intro.jobTitle}` : ''}</span>
            <span>{question && !done ? `Practice question ${progress.index} of ${progress.of}` : 'Not shared with the company'}</span>
          </div>
          <div className="echo-body" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
            <div className="echo-text">
              {!question ? (
                <>
                  <p className="echo-sub">Practise with Alexa</p>
                  <p className="echo-line">Rehearse with practice questions on the same skills, and get coaching after each answer.</p>
                  <button className="btn btn-primary" style={{ marginTop: 18 }} onClick={begin} disabled={state === 'thinking'}>{state === 'thinking' ? 'Getting ready…' : 'Start practice'}</button>
                </>
              ) : done ? (
                <>
                  <p className="echo-line">Practice done. Nice work.</p>
                  <div className="row" style={{ marginTop: 18 }}>
                    <button className="btn" onClick={begin}>Practise again</button>
                    <Link className="btn btn-primary" to={`/interview/${id}`}>Go to my real interview</Link>
                  </div>
                </>
              ) : (
                <>
                  <p className="echo-line">{question}</p>
                  {feedback ? (
                    <div className="stack" style={{ gap: 6, marginTop: 14, fontSize: 15 }}>
                      <p><b style={{ color: '#7fe3b0' }}>Good:</b> {feedback.strength}</p>
                      <p><b style={{ color: '#ffd38a' }}>Stronger:</b> {feedback.improve}</p>
                      <p><b style={{ color: '#7fd4ff' }}>Tip:</b> {feedback.tip}</p>
                    </div>
                  ) : (
                    <>
                      <textarea rows={3} value={answer}
                        onChange={(e) => { if (state === 'listening') { listener.current?.stop(); setState('idle'); } setAnswer(e.target.value); setErr(undefined); }}
                        placeholder={state === 'listening' ? 'Listening… speak your answer' : 'Type your answer, or press Speak'}
                        style={{ marginTop: 14, background: '#161a2b', borderColor: '#2a3049', color: '#eef0f8' }} />
                      <div className="row" style={{ marginTop: 10 }}>
                        <button className="btn btn-primary" onClick={submit} disabled={state === 'speaking' || state === 'thinking'}>Done answering</button>
                        {canListen && (state === 'listening'
                          ? <button className="btn" onClick={() => { listener.current?.stop(); setState('idle'); }}><Icon name="micOff" /> Stop listening</button>
                          : <button className="btn" onClick={startListening} disabled={state !== 'idle'}><Icon name="mic" /> Speak</button>)}
                      </div>
                    </>
                  )}
                </>
              )}
              {err && <p className="echo-sub" style={{ color: '#ff9f94' }}>{err}</p>}
            </div>
          </div>
          <div className={`echo-bar ${state}`} />
        </div>
        <div className="echo-base" />
      </div>
      <p className="faint" style={{ marginTop: 16, textAlign: 'center', maxWidth: 540 }}>
        Practice questions are different from the real interview. Nothing here is scored or shared. Works on an Echo Show with Alexa+ (preview) or any browser.
      </p>
    </div>
  );
}
