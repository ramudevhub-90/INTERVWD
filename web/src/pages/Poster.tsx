import { useParams } from 'react-router-dom';
import { api } from '../api';
import { Icon } from '../components/Icon';
import { Qr, qrLink } from '../components/Qr';
import { Loading, inviteUrl, useAuth, useLoad } from '../lib/util';

// An A4 poster for a round's invite link, for walk-in drives, job fairs and the office:
// candidates scan, sign up on their phone and (for online AI rounds) start right away.

export function Poster() {
  const { jobId = '', roundId = '' } = useParams();
  const { session } = useAuth();
  const { data, error } = useLoad(() => api.job(jobId), [jobId]);
  if (!data) return <Loading error={error} />;
  const round = data.rounds.find((r) => r.id === roundId);
  if (!round) return <Loading error="That round no longer exists." />;
  const url = inviteUrl(round);
  const now = round.mode !== 'human' && round.location !== 'office';
  const org = session?.orgName ?? '';

  return (
    <>
      <div className="row no-print" style={{ justifyContent: 'center', margin: '0 0 18px' }}>
        <button className="btn btn-primary" onClick={() => window.print()}><Icon name="file" /> Print or save as PDF</button>
      </div>
      <article className="poster">
        <header>
          <span className="poster-org">{org}</span>
          <span className="poster-tag">We’re hiring</span>
        </header>
        <h1>{data.job.title}</h1>
        {data.job.location && <p className="poster-loc">{data.job.location}</p>}
        <div className="poster-qr"><Qr url={qrLink(url)} size={300} /></div>
        <p className="poster-cta">Scan to interview</p>
        <p className="poster-sub">
          {now
            ? 'Sign up on your phone and start a short voice interview straight away, or book a time that suits you.'
            : 'Sign up on your phone and book a time for your interview.'}
        </p>
        <ol className="poster-steps">
          <li><b>1</b> Scan the code</li>
          <li><b>2</b> Add your CV{round.identityCheck ? ' and a photo' : ''}</li>
          <li><b>3</b> {now ? 'Interview now, by voice' : 'Pick a time'}</li>
        </ol>
        <footer>
          <span>{url.replace(/^https?:\/\//, '')}</span>
          <span>An AI asks the questions. A person at {org} makes every decision.</span>
          <span className="poster-brand"><span className="poster-logo">IV</span> Intervwd</span>
        </footer>
      </article>
    </>
  );
}
