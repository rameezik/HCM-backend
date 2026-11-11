const { User, PasswordResetToken } = require("./accounts");
const { Company, Department, Designation, Holiday } = require("./organization");
const { Employee } = require("./employees");
const { Attendance, Correction } = require("./attendance");
const { LeaveType, Leave } = require("./leave");
const { Payroll } = require("./payroll");
const {
  Announcement,
  Notification,
  AuditLog,
  AiLog,
} = require("./communication");
const { BiometricEnrollment, BiometricChallenge } = require("./biometrics");
const {
  KioskDevice,
  KioskChallenge,
  KioskEnrollmentGrant,
} = require("./attendanceTerminal");

module.exports = {
  KioskDevice,
  KioskChallenge,
  KioskEnrollmentGrant,
  PasswordResetToken,
  BiometricEnrollment,
  BiometricChallenge,
  User,
  Company,
  Department,
  Designation,
  LeaveType,
  Holiday,
  Employee,
  Attendance,
  Correction,
  Leave,
  Payroll,
  Announcement,
  Notification,
  AuditLog,
  AiLog,
};
