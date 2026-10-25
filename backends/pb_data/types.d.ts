// Repo-local stub for the PocketBase JSVM type file that the hooks reference
// (`/// <reference path="../pb_data/types.d.ts" />`).
//
// PocketBase GENERATES the real pb_data/types.d.ts next to its data directory on
// the server, and pb_data is not in this repo. This stub exists only so the hook
// files type-check in an editor on a dev machine; it is never deployed (hooks are
// copied as `pb_hooks/*.pb.js` only) and PocketBase regenerates its own file.
//
// Keep it to the globals these hooks actually use, typed loosely on purpose.

declare class Record {
  constructor(collection: any);
  id: string;
  getString(name: string): string;
  set(name: string, value: any): void;
  original(): Record;
}

declare const $app: any;
declare const $os: any;
declare const $apis: any;

declare function routerAdd(method: string, path: string, handler: (e: any) => any, ...middleware: any[]): void;
declare function onRecordCreate(handler: (e: any) => any, ...collections: string[]): void;
declare function onRecordUpdate(handler: (e: any) => any, ...collections: string[]): void;
declare function onRecordCreateRequest(handler: (e: any) => any, ...collections: string[]): void;
declare function onRecordUpdateRequest(handler: (e: any) => any, ...collections: string[]): void;
declare function onRecordDeleteRequest(handler: (e: any) => any, ...collections: string[]): void;
declare function onRecordAuthWithOAuth2Request(handler: (e: any) => any, ...collections: string[]): void;
declare function onRecordAfterCreateSuccess(handler: (e: any) => any, ...collections: string[]): void;
declare function onRecordAfterDeleteSuccess(handler: (e: any) => any, ...collections: string[]): void;

declare class ForbiddenError extends Error {}
declare class UnauthorizedError extends Error {}
declare class BadRequestError extends Error {}
declare class NotFoundError extends Error {}
