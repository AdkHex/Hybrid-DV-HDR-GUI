import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

const root = document.getElementById("root");

const showFatal = (message: string, details?: string) => {
  const output = details ? `${message}\n\n${details}` : message;
  if (!root) {
    document.body.innerHTML = `<pre style="white-space:pre-wrap;font-family:monospace;padding:16px;">${output}</pre>`;
    return;
  }
  root.innerHTML = `<pre style="white-space:pre-wrap;font-family:monospace;padding:16px;">${output}</pre>`;
};

window.addEventListener("error", (event) => {
  const details = event.error?.stack
    ? event.error.stack
    : event.filename
      ? `at ${event.filename}:${event.lineno}:${event.colno}`
      : undefined;
  showFatal(`App error: ${event.message}`, details);
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
  const details = event.reason instanceof Error ? event.reason.stack : undefined;
  showFatal(`App error: ${reason}`, details);
});

if (!root) {
  showFatal("Root element #root not found.");
} else {
  createRoot(root).render(<App />);
}
