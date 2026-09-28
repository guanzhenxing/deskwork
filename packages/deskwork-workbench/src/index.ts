/**
 * Host half of the workbench bundle. The empty apply keeps the client half
 * (the `./client` export) addressable from the Loader row the bundle's patch
 * inserts — the product behavior lives in the browser entry, nothing runs on
 * the host.
 */
export function apply(): void {}
