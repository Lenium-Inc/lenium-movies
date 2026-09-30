import { Toaster } from "@/components/ui/sonner";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import { CookieBanner } from "./components/CookieBanner";
import Home from "./pages/Home";
import Profile from "./pages/Profile";
import { WatchPage } from "./pages/Watch";
import MyList from "./pages/MyList";
import ShareInvite from "./pages/ShareInvite";
import SharedList from "./pages/SharedList";
import ProfilesPage from "./pages/ProfilesPage";
import AuthPage from "./pages/AuthPage";
import Terms from "./pages/Terms";
import Dmca from "./pages/Dmca";
import Privacy from "./pages/Privacy";

function Router() {
  return (
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
      <Route path="/terms" component={Terms} />
      <Route path="/privacy" component={Privacy} />
      <Route path="/dmca" component={Dmca} />
      <Route path="/404" component={NotFound} />
      <Route component={NotFound} />
    </Switch>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="dark">
        <Toaster />
        {/*
          One daily limit, and it is the server's.
          The global "mindful cinematic" modal is gone: it was a localStorage
          counter of 8 that ran in front of the real 10-per-profile allowance,
          opened on every route including the signed-out home page, and offered
          a "Reset limit" button -- so the product advertised a limit the viewer
          could switch off, next to a real one they could not. The remaining
          limit is enforced by /api/allowance/claim and explained once, on the
          watch page.
        */}
        <Router />
        <CookieBanner />
      </ThemeProvider>
    </ErrorBoundary>
  );
}
