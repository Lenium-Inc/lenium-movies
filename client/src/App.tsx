import { Toaster } from "@/components/ui/sonner";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import { MindfulCapModal } from "./components/player/MindfulCapModal";
import Home from "./pages/Home";
import HeroPreview from "./pages/HeroPreview";
import Profile from "./pages/Profile";
import { WatchPage } from "./pages/Watch";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/hero" component={HeroPreview} />
      <Route path="/profile" component={Profile} />
      <Route path="/watch/:id" component={WatchPage} />
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
        <MindfulCapModal />
        <Router />
      </ThemeProvider>
    </ErrorBoundary>
  );
}
