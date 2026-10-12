import { lazy, Suspense } from "react";
import { Toaster } from "@/components/ui/sonner";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import { RouteSeo } from "./components/layout/RouteSeo";

// Route-level code splitting. Home and NotFound stay eager: they are the
// landing and catch-all, the two chunks every session touches. Everything
// else — especially Watch, which drags the player, hls.js and dash.js —
// loads only when its path is actually visited.
const Profile = lazy(() => import("./pages/Profile"));
const WatchPage = lazy(() => import("./pages/Watch").then(m => ({ default: m.WatchPage })));
const MyList = lazy(() => import("./pages/MyList"));
const ShareInvite = lazy(() => import("./pages/ShareInvite"));
const SharedList = lazy(() => import("./pages/SharedList"));
const ProfilesPage = lazy(() => import("./pages/ProfilesPage"));
const AuthPage = lazy(() => import("./pages/AuthPage"));
const Terms = lazy(() => import("./pages/Terms"));
const Dmca = lazy(() => import("./pages/Dmca"));
const Privacy = lazy(() => import("./pages/Privacy"));
const AdminUsers = lazy(() => import("./pages/AdminUsers"));

function RouteFallback() {
  return (
    <div className="grid min-h-[60vh] place-items-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/15 border-t-white" />
    </div>
  );
}

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
      <Suspense fallback={<RouteFallback />}>
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
      </Suspense>
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
