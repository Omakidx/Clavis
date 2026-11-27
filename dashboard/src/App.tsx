import { Link, Redirect, Route, Switch, useLocation, type RouteProps } from 'wouter';
import { PRIVACY_URL } from './config';
import { SessionProvider, useSession } from './api/session';
import { AnnouncerProvider } from './ui/announcer';
import { ErrorState, Loading, usePage } from './ui/page';
import { Account } from './pages/Account';
import { Documents } from './pages/Documents';
import { Landing } from './pages/Landing';
import { NotFound } from './pages/NotFound';
import { WordDetail } from './pages/WordDetail';
import { Words } from './pages/Words';

function NavLink({ to, children }: { to: string; children: string }) {
  const [location] = useLocation();
  const active = location === to || location.startsWith(`${to}/`);
  return (
    <Link href={to} className="nav__link" {...(active ? { 'aria-current': 'page' as const } : {})}>
      {children}
    </Link>
  );
}

function Header() {
  const { state } = useSession();
  return (
    <header className="site-header">
      <div className="site-header__inner">
        <a className="brand" href="/">
          <img src="/favicon.svg" alt="" width="28" height="28" />
          <span>Clavis</span>
        </a>
        {state.status === 'signed-in' ? (
          <nav aria-label="Main" className="nav">
            <NavLink to="/words">Saved words</NavLink>
            <NavLink to="/documents">Documents</NavLink>
            <NavLink to="/account">Account</NavLink>
          </nav>
        ) : null}
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="site-footer">
      <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer">
        Privacy policy<span className="sr-only"> (opens in a new tab)</span>
      </a>
    </footer>
  );
}

/** Protected route: waits for the session probe, sends signed-out visitors to `/`. */
function Private(props: RouteProps) {
  const { state, retry } = useSession();
  const heading = usePage('Clavis', state.status !== 'loading');
  if (state.status === 'loading') return <Loading label="Loading…" />;
  if (state.status === 'error') {
    return (
      <>
        <h1 ref={heading} tabIndex={-1}>
          Clavis
        </h1>
        <ErrorState failure={state.failure} onRetry={retry} />
      </>
    );
  }
  if (state.status === 'signed-out') return <Redirect to="/" replace />;
  return <Route {...props} />;
}

function Shell() {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Header />
      <main id="main" className="page">
        <Switch>
          <Route path="/" component={Landing} />
          <Private path="/words" component={Words} />
          <Private path="/words/:key" component={WordDetail} />
          <Private path="/documents" component={Documents} />
          <Private path="/account" component={Account} />
          <Route component={NotFound} />
        </Switch>
      </main>
      <Footer />
    </>
  );
}

export function App() {
  return (
    <SessionProvider>
      <AnnouncerProvider>
        <Shell />
      </AnnouncerProvider>
    </SessionProvider>
  );
}
