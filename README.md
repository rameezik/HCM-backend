# HCM Lite Backend

### Human Capital Management System — REST API

HCM Lite Backend is a RESTful API built with Node.js, Express.js, MongoDB, and Mongoose. It powers the HCM Lite application by providing authentication, employee management, department management, attendance tracking, leave management, payroll processing, and workforce analytics.

The backend is designed to support multiple organizations with role-based access control and company-level data isolation.

## Overview

HCM Lite provides a centralized backend for managing human resource operations.

The system supports three primary user roles:

- **Admin:** Manages company settings, HR accounts, departments, employees, payroll finalization, and organizational records.
- **HR:** Manages employee records, attendance corrections, leave approvals, and payroll drafts.
- **Employee:** Accesses personal information, attendance, leave requests, and finalized payslips.

The backend communicates with a separate Next.js frontend and stores application data in MongoDB Atlas.

## Tech Stack

| Technology | Purpose |
|---|---|
| Node.js 24+ | JavaScript runtime |
| Express.js 5 | REST API framework |
| MongoDB Atlas | Cloud database |
| Mongoose | Database modeling |
| JSON Web Tokens | Authentication |
| bcryptjs | Password hashing |
| Zod | Request validation |
| Helmet | HTTP security headers |
| CORS | Cross-origin access control |
| Express Rate Limit | API rate limiting |
| Nodemailer | Email delivery |
| PDFKit | PDF generation |
| csv-parse | CSV processing |
| Luxon | Date and time handling |

## Core Features

### Authentication and Authorization

- Company registration and workspace creation
- Admin account registration
- User login and logout
- Secure HttpOnly cookie sessions
- Role-based access control
- Employee account activation and deactivation
- Temporary password change workflow
- Password recovery through email
- Session revocation

### Company Management

- Multi-company architecture
- Company-specific data isolation
- Company settings
- Department management
- Designation management
- HR account management

### Employee Management

- Employee registration
- Employee profile management
- Department and designation assignment
- Employment status tracking
- Employee account management
- CSV employee import and export

### Attendance Management

- Employee check-in and check-out
- Attendance history
- Attendance status tracking
- Working-hour calculations
- Attendance correction requests
- HR attendance management
- Attendance analytics

### Face Recognition Attendance

The backend includes support for local biometric attendance using open-source face-recognition models.

The biometric workflow includes:

- Employee face enrollment
- Face detection
- Face embedding generation
- Server-side identity verification
- Face-verified check-in
- Face-verified check-out
- Biometric template protection

Face recognition requires additional local model files and Python dependencies.

The implementation does not claim robust liveness detection or protection against sophisticated presentation attacks.

A non-biometric attendance alternative is supported.

### Leave Management

- Leave requests
- Leave approval and rejection
- Leave balance tracking
- Leave cancellation
- Leave history
- Leave policy enforcement

### Payroll Management

- Monthly payroll calculations
- Salary components
- Attendance-based deductions
- Payroll draft generation
- Payroll finalization
- Payslip generation
- PDF payslip downloads

### Analytics and Reporting

- Employee statistics
- Department statistics
- Attendance analytics
- Leave analytics
- Payroll summaries
- HR reporting

Analytics are generated from database records rather than fabricated data.

## Project Architecture

```text
HCM-backend/
│
├── server.js
├── package.json
├── package-lock.json
│
├── src/
│   ├── app.js
│   ├── config/
│   ├── models/
│   ├── routes/
│   └── services/
│
├── scripts/
├── tests/
├── docs/
└── README.md
```

### Architecture Overview

```text
Next.js Frontend
       |
       v
Express REST API
       |
       v
Authentication & Authorization
       |
       v
Business Logic Services
       |
       v
Mongoose Models
       |
       v
MongoDB Atlas
```

## Getting Started

### Prerequisites

Before running the backend, install or configure:

- Node.js 24.5.0 or later
- npm
- Git
- MongoDB Atlas or a MongoDB replica set

A MongoDB replica set is required for transactional workflows.

### 1. Clone the Repository

```bash
git clone https://github.com/rameezik/HCM-backend.git
```

Navigate
