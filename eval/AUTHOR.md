# Authoring brief

This is an evaluation run of the app-e2e skills. Your working folder is a checkout of an Android app
(ownCloud). Run steps 1 to 4 of the app-e2e skill on it, and stop after `e2e/TESTCASES.md`.

Write only for these areas, and for nothing else in the app:

- file browsing and file operations
- transfers (upload, download, available offline)
- settings, including security and auto uploads

Already settled by the operator for this run:

- The build under test is the debug build of this checkout. It is already installed on the connected phone and is the release candidate.
- The app is already connected to a local test server and signed in to a test account.
- Do not install, uninstall, sign in, sign out or type any password. Read the package name from the source and confirm it against the installed build.
- If the phone is not ready, or the app is not installed or not signed in, stop and report that. Do not fix it.

Rules for this run:

- Both user gates (CUJs, test cases) are passed without edits. Treat each as approved and go on. Do not write an `Approved:` line in any file.
- Do not run any case, and do not drive the phone beyond what step 1 (explore) needs.
- Do not search the web for this app's test plans. Read nothing outside the working folder except the app-e2e skills themselves.
- The output is scored against a reference suite. Do not look for it.
- Write everything into `e2e/` in the working folder. Put no secrets in any file.
