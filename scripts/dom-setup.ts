import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
const g = globalThis as any;
g.window = dom.window; g.document = dom.window.document; Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
g.localStorage = dom.window.localStorage; g.HTMLElement = dom.window.HTMLElement; g.Node = dom.window.Node;
g.IS_REACT_ACT_ENVIRONMENT = true;
g.AbortController = dom.window.AbortController;
// speed up all of the component's sleeps
const realSetTimeout_ = globalThis.setTimeout;
(globalThis as any).setTimeout = (fn: any, ms?: number, ...a: any[]) => realSetTimeout_(fn, Math.min(ms ?? 0, 5) , ...a);
(dom.window as any).setTimeout = (globalThis as any).setTimeout;


export const realSetTimeout = realSetTimeout_;
