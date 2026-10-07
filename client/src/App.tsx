import { Toaster } from "@/components/ui/sonner";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import Profile from "./pages/Profile";
import { WatchPage } from "./pages/Watch";
import MyList from "./pages/MyList";
import ShareInvite from "./pages/ShareInvite";
import SharedList from "./pages/SharedList";
import ProfilesPage from "./pages/ProfilesPage";
import AuthPage from "./pages/AuthPage";
import { RouteSeo } from "./components/layout/RouteSeo";
import Terms from "./pages/Terms";
import Dmca from "./pages/Dmca";
import Privacy from "./pages/Privacy";
import AdminUsers from "./pages/AdminUsers";

function Router() {
  return (
    <>
      {/*
        Inside the router, above the Switch, so it sees the location before any
        page renders. Mounted in the one place every route goes through: a
        per-page call site would have made "did this page remember to set its own
        title" an open question, and the answer would have been visible only in
        a search result.
      */}
      <RouteSeo />
      <Switch>
        <Route path="/" component={Home} />
        {/* `/hero` served a scratch design page with fifteen hardcoded fake
          titles, invented genre taxonomies and a raw `alert()` as its details
          view, on a public route with no auth guard. Removed rather than
          hidden: it looked like the real product and was not. */}
        <Route path="/profiles" component={ProfilesPage} />
        <Route path="/login" component={() => <AuthPage mode="login" />} />
        <Route path="/signup" component={() => <AuthPage mode="signup" />} />
        <Route path="/profile" component={Profile} />
        <Route path="/my-list" component={MyList} />
        {/* Canonical invite link shape, plus the `/list/share/...` prefix that
          links minted outside this app (and older share messages) use. Both
          resolve to the same public page, which reads the token itself. */}
        <Route path="/list/share/:token" component={ShareInvite} />
        <Route path="/list/share/shared/:ownerId" component={SharedList} />
        <Route path="/share/shared/:ownerId" component={SharedList} />
        <Route path="/share/:token" component={ShareInvite} />
        <Route path="/watch/:id" component={WatchPage} />
        {/*
          The account roster. Publicly routed, because the page itself is the
          gate: it renders a signed-out or not-allowed state rather than
          redirecting, so the reason is visible instead of the operator being
          bounced to a login page with no explanation. `/api/admin/users` makes
          its own server-side decision regardless of what this route allows.
        */}
        <Route path="/admin/users" component={AdminUsers} />
        <Route path="/terms" component={Terms} />
        <Route path="/privacy" component={Privacy} />
        <Route path="/dmca" component={Dmca} />
        <Route path="/404" component={NotFound} />
        <Route component={NotFound} />
      </Switch>
    </>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="dark">
        <Toaster />
        {/*
          `sv-shell` is the page's lighting, not decoration: it owns the base
          colour and a pair of violet/cyan auroras behind everything, pinned to
          the viewport so the glow stays put while the shelves scroll over it.
          Applied once here rather than per page, so no route can end up on a
          flat black background.
        */}
        <div className="sv-shell min-h-screen">
          <Router />
        </div>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
