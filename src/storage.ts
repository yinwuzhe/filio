import { isLibrary, type Library } from "./model";

let connection: Promise<IDBDatabase> | undefined;
function database(): Promise<IDBDatabase> {
  if (!connection)
    connection = new Promise((resolve, reject) => {
      const request = indexedDB.open("folio", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("library");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        connection = undefined;
        reject(new Error("Your local library could not be opened."));
      };
      request.onblocked = () =>
        reject(new Error("Please close other Folio windows and try again."));
    });
  return connection;
}

export async function loadLibrary(): Promise<Library | undefined> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db
      .transaction("library", "readonly")
      .objectStore("library")
      .get("current");
    request.onsuccess = () => {
      if (request.result === undefined) resolve(undefined);
      else if (isLibrary(request.result)) resolve(request.result);
      else
        reject(
          new Error(
            "Your saved library could not be read. Existing data has not been changed.",
          ),
        );
    };
    request.onerror = () =>
      reject(new Error("Your saved library could not be read."));
  });
}

export async function saveLibrary(library: Library): Promise<void> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("library", "readwrite");
    transaction.objectStore("library").put(library, "current");
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(
        new Error(
          "Local storage is full or unavailable. Recent changes may not be saved.",
        ),
      );
    transaction.onabort = () =>
      reject(
        new Error(
          "Your library could not be saved. Please free up disk space.",
        ),
      );
  });
}
