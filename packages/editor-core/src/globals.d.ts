// `structuredClone` is a global in both browsers and Node 17+, but its type lives in the DOM
// lib. editor-core is environment-neutral, so we declare it here instead of pulling in DOM.
declare function structuredClone<T>(value: T): T;
