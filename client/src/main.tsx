import { createRoot } from "react-dom/client";
import App from "./App";
import { applyTheme } from "./services/settings";
import { AuthProvider } from "./context/AuthContext";
import { LocalSessionProvider } from "./context/LocalSessionContext";
import { ActiveProfileProvider } from "./context/ActiveProfileContext";
import "./index.css";

applyTheme();

/*
 * No tRPC provider and no react-query cache.
 *
 * The template shipped a full tRPC client pointed at `/api/trpc` with a
 * `manus-cookie` session reader, wrapping the whole app. Nothing in the product
 * used it -- every request goes through the typed services in `services/*`
 * against the Flask backend -- so it was a provider that could only fail: the
 * `/api` proxy goes to the Flask server, which serves no `/api/trpc` route, so
 * every call through it 404'd. It is removed rather than left as a dependency
 * the product does not have.
 */
createRoot(document.getElementById("root")!).render(
  <LocalSessionProvider>
    <AuthProvider>
      <ActiveProfileProvider>
        <App />
      </ActiveProfileProvider>
    </AuthProvider>
  </LocalSessionProvider>
);