import "./theme.css";
import "./GtdWorkspace";

const rootEl = document.querySelector<HTMLElement>("[data-generated-space-root]");
if (!rootEl) {
  throw new Error("missing generated space root element");
}

// The custom element is the one and only owner of workspace state and DOM.
// Mount it once without a framework lifecycle so development checks or host
// rerenders cannot disconnect it and replace its loaded state.
const shell = document.createElement("div");
shell.className = "hatch-space-root";
shell.dataset.hatchSpaceRoot = "";
shell.append(document.createElement("gtd-workspace"));
rootEl.replaceChildren(shell);
