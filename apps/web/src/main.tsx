import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "@sejire/app";
import { AppErrorBoundary } from "./components/ErrorBoundary.tsx";
import { I18nProvider } from "./lib/i18n/I18nProvider.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
    </I18nProvider>
  </StrictMode>
);
