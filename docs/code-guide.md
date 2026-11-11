# Reading the backend

Start with `server.js`, then `src/app.js`. The server connects MongoDB and starts Express; the app installs middleware and mounts the API.

`src/routes/index.js` shows the route order. Public registration, login and terminal access are mounted before authentication. Company APIs are mounted after authentication.

## Finding a feature

| Feature | Routes | Main business logic |
| --- | --- | --- |
| Login and account setup | `publicAccountRoutes.js`, `publicAuthRoutes.js`, `sessionRoutes.js` | `sessionService.js`, `authRecoveryService.js` |
| Company settings and departments | `organizationRoutes.js` | `accountManagementService.js` |
| Employee records | `employeeRoutes.js`, `employeePhotoRoutes.js` | `employeePhotoService.js`, `accountManagementService.js` |
| User access and password policy | `userRoutes.js` | `accountManagementService.js` |
| Attendance | `attendanceRoutes.js` | `attendanceWriter.js`, `attendanceService.js` |
| Dashboards and charts | `/dashboard` in the route index | `dashboardService.js`, `attendanceAnalyticsService.js` |
| Leave | `leaveRoutes.js` | `leaveService.js` |
| Payroll and payslips | `payrollRoutes.js` | `payrollService.js`, `rules.js` |
| Notices and audit history | `communicationRoutes.js` | `context.js` |
| Face attendance | `publicKioskRoutes.js`, `kioskManagementRoutes.js`, `biometricRoutes.js` | `terminalEnrollmentService.js`, `kioskRecognitionService.js`, `biometricService.js` |

Route files are in `src/routes`; service files are in `src/services`. Routes validate requests, check access, call business logic and send a response. Services perform database operations and calculations.

## Models and shared code

`src/models` groups schemas by domain: accounts, organization, employees, attendance, leave, payroll, communication and biometrics. `index.js` exports the models. `schema.js` applies common timestamps, company scoping and indexes.

- `companyContext.js` limits queries to the authenticated company.
- `context.js` provides transactions, audit logging and common employee filters.
- `authMiddleware.js` checks the session, account and role.
- `errorHandler.js` converts errors into API responses.
- `routes/schemas` holds shared request validation.

Face-template encryption lives in `biometricTemplate.js`; embedding comparisons live in `faceEmbeddings.js`; model execution lives in `localFaceProvider.js`. Old `kiosk` file and model names remain for compatibility with existing records and API clients. The feature's public name is Attendance Terminal.

For a change, follow one request from its route into its service and model. Keep permissions, company filters and transaction locks in place. Run `npm test` before committing. Model tests need the local face runtime; see [Attendance Terminal setup](attendance-terminal.md).
