import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

const root = document.getElementById("root");

const showFatal = (message: string) => {
  if (!root) {
    document.body.innerHTML = `<pre style="white-space:pre-wrap;font-family:monospace;padding:16px;">${message}</pre>`;
    return;
  }
  root.innerHTML = `<pre style="white-space:pre-wrap;font-family:monospace;padding:16px;">${message}</pre>`;
};

window.addEventListener("error", (event) => {
  showFatal(`App error: ${event.message}`);
});

window.addEventListener("unhandledrejection", (event) => {
  showFatal(`App error: ${String(event.reason)}`);
});

if (!root) {
  showFatal("Root element #root not found.");
} else {
  createRoot(root).render(<App />);
}
