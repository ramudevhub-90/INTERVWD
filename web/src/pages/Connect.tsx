import { useState } from 'react';
import { Navigate, useLocation, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { HttpApi } from '../api/http';
import { Icon } from '../components/Icon';
import { PublicTop } from '../components/Shell';
import { Loading, useAuth, useLoad } from '../lib/util';

/** Account linking: Alexa+ (or another MCP client) sends the recruiter here to approve access. */
export function Connect() {
  const { session } = useAuth();
  const location = useLocation();
  const [params] = useSearchParams();
  const id = params.get('request') ?? '';
  const http = api instanceof HttpApi ? api : undefined;
  const { data, error } = useLoad(() => (http && session ? http.oauthRequest(id) : Promise.resolve(undefined)), [id, session]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();

  if (session === undefined) return <Loading />;
  if (!session) return <Navigate to={`/signin?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;

  const decide = async (approve: boolean) => {
    if (!http) return;
    setBusy(true);
    try {
      window.location.assign(await http.oauthDecide(id, approve));
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <>
      <PublicTop />
      <div className="centered">
        <div className="card narrow" style={{ textAlign: 'center' }}>
          {!http ? (
            <p className="muted">Account linking needs the live server.</p>
          ) : !data ? (
            <Loading error={error} />
          ) : (
            <>
              <div className="orb" style={{ margin: '0 auto 14px' }}><Icon name="alexa" size={26} /></div>
              <h2>Connect {data.clientName} to Intervwd</h2>
              <p className="muted" style={{ margin: '10px 0 18px' }}>
                {data.clientName} will be able to read {session.orgName}'s interviews and reports, add interview slots, and move candidates on after you say yes.
              </p>
              <button className="btn btn-primary btn-block" disabled={busy} onClick={() => decide(true)}>Allow</button>
              <button className="btn btn-ghost btn-block" style={{ marginTop: 8 }} disabled={busy} onClick={() => decide(false)}>Cancel</button>
              <p className="faint" style={{ marginTop: 12 }}>Signed in as {session.email}</p>
              {err && <p className="error">{err}</p>}
            </>
          )}
        </div>
      </div>
    </>
  );
}
