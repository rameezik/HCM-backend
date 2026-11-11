const express = require("express");
const { auth } = require("../middleware/authMiddleware");
const { asyncHandler } = require("../utils/http");
const { dashboard } = require("../services/dashboardService");
const { writeAttendance } = require("../services/attendanceWriter");
const { sendSession } = require("../services/sessionService");
const companySchema = require("./schemas/company");

const router = express.Router();

router.use(require("./publicAccountRoutes"));
router.use(
  "/auth",
  require("./publicAuthRoutes")({ companySchema, signIn: sendSession }),
);
router.use(["/attendance-terminal", "/kiosk"], require("./publicKioskRoutes"));

router.use(auth);

router.use(
  ["/attendance-terminal-management", "/kiosk-management"],
  require("./kioskManagementRoutes"),
);
router.use(require("./employeePhotoRoutes"));
router.use(require("./sessionRoutes"));
router.use(require("./organizationRoutes"));
router.use(require("./userRoutes"));
router.use(require("./employeeRoutes"));
router.use(require("./attendanceRoutes"));
router.use(require("./leaveRoutes"));
router.use(require("./payrollRoutes"));
router.get(
  "/dashboard",
  asyncHandler(async (req, res) => {
    res.json(await dashboard(req.user, req.query));
  }),
);
router.use(require("./communicationRoutes"));
router.use("/ai", require("./aiRoutes"));
router.use("/biometrics", require("./biometricRoutes")({ writeAttendance }));

module.exports = router;
