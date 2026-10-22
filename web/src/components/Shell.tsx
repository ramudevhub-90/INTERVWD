import { Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { initials, useAuth } from '../lib/util';
import { Brand, Icon } from './Icon';

/** Layout for every recruiter page; sends signed-out visitors to sign-in. */
export function Shell() {
  const { session, setSession } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  if (session === undefined) return <div className="empty faint">Loading…</div>;
  if (!session || session.role !== 'recruiter') return <Navigate to={`/signin?next=${encodeURIComponent(location.pathname)}`} replace />;

  const signOut = async () => {
    await api.signOut();
    setSession(null);
    navigate('/');
  };

  return (
    <div className="shell">
      <aside className="side">
        <Brand to="/app" />
        <NavLink to="/app" end className="nav-link"><Icon name="home" /><span>Dashboard</span></NavLink>
        <NavLink to="/app/jobs" className="nav-link"><Icon name="briefcase" /><span>Jobs</span></NavLink>
        <NavLink to="/app/alexa" className="nav-link"><Icon name="alexa" /><span>Alexa+</span></NavLink>
        <button className="nav-link btn-ghost" style={{ border: 0, background: 'none', cursor: 'pointer', font: 'inherit' }} onClick={signOut} title="Sign out">
          <Icon name="logout" /><span>Sign out</span>
        </button>
        <div className="foot row">
          <div className="avatar">{initials(session.name)}</div>
          <div style={{ minWidth: 0 }}>
            <div className="small ellipsis" style={{ fontWeight: 500 }}>{session.name}</div>
            <div className="faint ellipsis">{session.orgName}</div>
          </div>
        </div>
        {api.mode === 'mock' && <div className="faint" style={{ padding: '10px 8px 0' }}>Sample data</div>}
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}

export function PageHead({ title, crumbs, children, sub }: { title: string; sub?: string; crumbs?: { to: string; label: string }[]; children?: React.ReactNode }) {
  return (
    <div className="page-head">
      <div>
        {crumbs && (
          <div className="crumbs">
            {crumbs.map((c, i) => (
              <span key={c.to}>{i > 0 && ' / '}<NavLink to={c.to}>{c.label}</NavLink></span>
            ))}
          </div>
        )}
        <h1>{title}</h1>
        {sub && <p className="muted" style={{ marginTop: 6 }}>{sub}</p>}
      </div>
      {children && <div className="row wrap">{children}</div>}
    </div>
  );
}

export function PublicTop({ right }: { right?: React.ReactNode }) {
  return (
    <header className="topbar">
      <Brand />
      <div className="row">{right}</div>
    </header>
  );
}
