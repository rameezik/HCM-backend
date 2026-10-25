# Enrollment, departments, account navigation, photos and graphs

Face enrollment now puts its real consent and camera controls first, with an explicit blocked reason and retry if the linked profile, local runtime/models or encryption key is unavailable. The full notice remains accessible below. Account and company changes reset biometric status, capture state and consent. Profile photographs are separate from biometric enrollment and never become a verification template automatically.

Departments now have a dedicated visible Add/Create form, edit and safe delete actions, real employee counts, paginated members and assignment. The existing real catalog APIs are retained. Temporary-password activation redirects to the actual role password route instead of replacing arbitrary feature content beneath an unrelated page heading. Change Password is in the fixed bottom sidebar account menu, while the main menu scrolls.

Employee photo APIs use existing authenticated company/profile scopes:

- `POST /api/employees/:id/photo` accepts a bounded JPEG/PNG/WebP data URL and stores a normalized JPEG in MongoDB.
- `GET /api/employees/:id/photo` streams an authenticated private JPEG.
- `DELETE /api/employees/:id/photo` removes the stored image.

Sharp0.34.5 decodes, corrects orientation, limits pixel count, resizes to at most512px and strips image metadata. Hidden photo bytes are excluded from ordinary employee JSON and audits; only `photoUpdatedAt` is public to authorized profile readers. Upload/edit permission is Admin within the company, HR for ordinary employees, or a linked account for its own picture. The same-origin proxy permits JPEG only on the exact employee-photo GET route. The frontend shows actual photos or name-derived initials and supports file selection, upload, removal and refresh.

Attendance graphs have dedicated `/admin/attendance-graphs`, `/hr/attendance-graphs` and `/employee/attendance-graphs` pages and navigation, reusing the real MongoDB analytics API and existing Recharts components.

Verification: the full backend suite passed105checks, frontend transport suite passed8checks, lint and the production build passed (57static pages plus the API proxy). The actual isolated Chromium run passed department CRUD/reference409, private photo upload/read/refresh and tenant rejection, first-login activation and sidebar navigation, own-photo replacement, top enrollment controls with actual camera-fixture/local SFace attendance, and all three graph pages. Fixtures and the child API were removed; normal application data was preserved.

The final-source Docker image also passed Sharp JPEG normalization and real128-D SFace same/different-person inference as UID1000 with networking disabled; runtime.env/buildCAsecret were absent. No live Vercel/Render deployment or physical-camera/PAD certification is claimed. Render still requires the supplied Docker runtime/models, stable biometric key and office settings; Vercel must deploy the HCM-frontend repository with the correct backend target. The live deployment URL was requested separately for diagnosis.
