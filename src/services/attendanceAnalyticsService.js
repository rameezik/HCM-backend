const mongoose = require("mongoose");
const { z } = require("zod");
const M = require("../models");
const ApiError = require("../utils/ApiError");
const { dates, isoDate } = require("./rules");

const objectId = (value, label) => {
  const id = value?._id || value;
  if (!mongoose.isValidObjectId(id))
    throw new ApiError(422, `${label} must be a valid record ID.`);
  return new mongoose.Types.ObjectId(String(id));
};
const querySchema = z
  .object({
    start: z.string().refine(isoDate).optional(),
    end: z.string().refine(isoDate).optional(),
    department: z
      .string()
      .regex(/^[a-f\d]{24}$/i)
      .optional(),
    employee: z
      .string()
      .regex(/^[a-f\d]{24}$/i)
      .optional(),
    page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

function localDate(now, timezone) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const values = Object.fromEntries(
      parts.map((part) => [part.type, part.value]),
    );
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    throw new ApiError(422, "The company attendance timezone is invalid.");
  }
}

const sumIf = (expression) => ({ $sum: { $cond: [expression, 1, 0] } });
const same = (key, value) => ({ $eq: [key, value] });
function countsGroup(key) {
  return {
    $group: {
      _id: key,
      expectedDays: sumIf("$isWorkingDay"),
      recordedDays: sumIf("$recorded"),
      attended: sumIf("$recorded"),
      present: sumIf({ $and: ["$recorded", { $not: ["$late"] }] }),
      late: sumIf({ $and: ["$recorded", "$late"] }),
      absent: sumIf(same("$status", "absent")),
      onLeave: sumIf(same("$status", "on_leave")),
      halfDay: sumIf(same("$status", "half_day")),
      missingCheckout: sumIf(same("$status", "missing_checkout")),
      workedHours: { $sum: "$hours" },
      denominator: {
        $sum: {
          $cond: [
            {
              $and: ["$isWorkingDay", { $ne: ["$status", "on_leave"] }],
            },
            1,
            0,
          ],
        },
      },
      weightedPresence: {
        $sum: {
          $cond: [
            { $and: ["$isWorkingDay", "$recorded"] },
            { $cond: [same("$status", "half_day"), 0.5, 1] },
            0,
          ],
        },
      },
    },
  };
}
const ratesStage = {
  $set: {
    attendanceRate: {
      $round: [
        {
          $cond: [
            { $gt: ["$denominator", 0] },
            {
              $multiply: [
                { $divide: ["$weightedPresence", "$denominator"] },
                100,
              ],
            },
            0,
          ],
        },
        2,
      ],
    },
    workedHours: { $round: ["$workedHours", 2] },
  },
};
const removeInternalCounts = { $unset: ["weightedPresence", "denominator"] };
const emptyCounts = () => ({
  expectedDays: 0,
  recordedDays: 0,
  attended: 0,
  present: 0,
  absent: 0,
  late: 0,
  onLeave: 0,
  halfDay: 0,
  missingCheckout: 0,
  attendanceRate: 0,
  workedHours: 0,
});

function rowsPipeline(companyId, calendar, workDates, now, maximumShiftHours) {
  const lowerDate = calendar[0];
  const upperDate = calendar.at(-1);
  const reference = [
    { $eq: ["$employee", "$$employee"] },
    { $eq: ["$company", companyId] },
  ];
  return [
    {
      $lookup: {
        from: M.Department.collection.name,
        let: { department: "$department" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$_id", "$$department"] },
                  { $eq: ["$company", companyId] },
                ],
              },
            },
          },
          { $project: { _id: 1, name: 1 } },
        ],
        as: "_department",
      },
    },
    {
      $lookup: {
        from: M.Attendance.collection.name,
        let: { employee: "$_id" },
        pipeline: [
          {
            $match: {
              date: { $in: calendar },
              $expr: { $and: reference },
            },
          },
          {
            $project: {
              _id: 1,
              date: 1,
              checkIn: 1,
              checkOut: 1,
              status: 1,
              late: 1,
              verificationMethod: 1,
              source: 1,
              checkInMethod: 1,
              checkOutMethod: 1,
              "verification.method": 1,
              "checkOutVerification.method": 1,
              "rules.maxShiftHours": 1,
            },
          },
        ],
        as: "_attendance",
      },
    },
    {
      $lookup: {
        from: M.Leave.collection.name,
        let: { employee: "$_id" },
        pipeline: [
          {
            $match: {
              status: "approved",
              start: { $lte: upperDate },
              end: { $gte: lowerDate },
              $expr: { $and: reference },
            },
          },
          { $project: { _id: 0, days: 1, unpaid: 1 } },
        ],
        as: "_leaves",
      },
    },
    {
      $set: {
        _dates: {
          $setUnion: [
            workDates,
            { $map: { input: "$_attendance", as: "row", in: "$$row.date" } },
            {
              $setIntersection: [
                calendar,
                {
                  $reduce: {
                    input: "$_leaves",
                    initialValue: [],
                    in: { $setUnion: ["$$value", "$$this.days"] },
                  },
                },
              ],
            },
          ],
        },
      },
    },
    { $unwind: "$_dates" },
    {
      $match: {
        $expr: {
          $and: [
            { $in: ["$_dates", calendar] },
            { $gte: ["$_dates", "$joinDate"] },
            {
              $or: [
                { $eq: [{ $ifNull: ["$exitDate", ""] }, ""] },
                { $lte: ["$_dates", "$exitDate"] },
              ],
            },
          ],
        },
      },
    },
    {
      $set: {
        _record: {
          $arrayElemAt: [
            {
              $filter: {
                input: "$_attendance",
                as: "row",
                cond: { $eq: ["$$row.date", "$_dates"] },
              },
            },
            0,
          ],
        },
        _leave: {
          $arrayElemAt: [
            {
              $filter: {
                input: "$_leaves",
                as: "leave",
                cond: { $in: ["$_dates", "$$leave.days"] },
              },
            },
            0,
          ],
        },
      },
    },
    {
      $set: {
        _recorded: { $ne: [{ $ifNull: ["$_record._id", null] }, null] },
        _onLeave: { $ne: [{ $ifNull: ["$_leave", null] }, null] },
        _hours: {
          $cond: [
            { $ne: [{ $ifNull: ["$_record.checkIn", null] }, null] },
            {
              $divide: [
                {
                  $subtract: [
                    { $ifNull: ["$_record.checkOut", now] },
                    "$_record.checkIn",
                  ],
                },
                3600000,
              ],
            },
            0,
          ],
        },
      },
    },
    {
      $project: {
        _id: "$_record._id",
        employee: {
          _id: "$_id",
          name: "$name",
          code: "$code",
          department: {
            $ifNull: [
              { $arrayElemAt: ["$_department", 0] },
              { _id: null, name: "Unassigned" },
            ],
          },
        },
        date: "$_dates",
        checkIn: { $ifNull: ["$_record.checkIn", null] },
        checkOut: { $ifNull: ["$_record.checkOut", null] },
        status: {
          $cond: [
            "$_recorded",
            "$_record.status",
            { $cond: ["$_onLeave", "on_leave", "absent"] },
          ],
        },
        recorded: "$_recorded",
        isWorkingDay: {
          $or: [{ $in: ["$_dates", workDates] }, "$_onLeave", "$_recorded"],
        },
        late: {
          $cond: [
            "$_recorded",
            {
              $or: [
                { $ifNull: ["$_record.late", false] },
                same("$_record.status", "late"),
              ],
            },
            false,
          ],
        },
        hours: {
          $round: [
            {
              $cond: [
                {
                  $and: [
                    { $gte: ["$_hours", 0] },
                    {
                      $or: [
                        {
                          $ne: [{ $ifNull: ["$_record.checkOut", null] }, null],
                        },
                        {
                          $lte: [
                            "$_hours",
                            {
                              $ifNull: [
                                "$_record.rules.maxShiftHours",
                                maximumShiftHours,
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
                "$_hours",
                0,
              ],
            },
            4,
          ],
        },
        unpaid: {
          $and: [
            { $not: ["$_recorded"] },
            { $ifNull: ["$_leave.unpaid", false] },
          ],
        },
        verificationMethod: {
          $cond: [
            "$_recorded",
            {
              $ifNull: [
                "$_record.verification.method",
                {
                  $ifNull: [
                    "$_record.verificationMethod",
                    { $ifNull: ["$_record.source", "web"] },
                  ],
                },
              ],
            },
            null,
          ],
        },
        checkOutMethod: {
          $ifNull: [
            "$_record.checkOutVerification.method",
            { $ifNull: ["$_record.checkOutMethod", null] },
          ],
        },
      },
    },
  ];
}

/**
 * Company/role-scoped attendance report built from MongoDB aggregation. Absences
 * are derived from actual employment and company calendars, never seeded records.
 * `options.now` is an internal server/test clock; it is not accepted from HTTP.
 */
async function analytics(user, input = {}, options = {}) {
  if (!user || !["admin", "hr", "employee"].includes(user.role))
    throw new ApiError(403, "Your role cannot access attendance analytics.");
  if (!user.company)
    throw new ApiError(403, "A company-scoped login is required.");
  const companyId = objectId(user.company, "Company");
  const query = querySchema.parse(
    Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== ""),
    ),
  );
  if (user.role === "employee") {
    if (!user.employee)
      throw new ApiError(422, "This login needs a linked employee profile.");
    if (
      query.department ||
      (query.employee && query.employee !== String(user.employee))
    )
      throw new ApiError(
        403,
        "Employees can report only on their own attendance.",
      );
    query.employee = String(user.employee);
  }
  const company = await M.Company.findOne({ _id: companyId }).lean();
  if (!company) throw new ApiError(404, "Company not found.");
  const timezone = company.timezone || "UTC";
  const now = options.now ? new Date(options.now) : new Date();
  if (Number.isNaN(now.getTime()))
    throw new ApiError(422, "Invalid attendance clock.");
  const calendarDate = localDate(now, timezone);
  let asOf = calendarDate;
  const timeParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const localTime = Object.fromEntries(
    timeParts.map((part) => [part.type, part.value]),
  );
  const minutes = Number(localTime.hour) * 60 + Number(localTime.minute);
  const toMinutes = (value) => {
    const [hour, minute] = String(value).split(":").map(Number);
    return hour * 60 + minute;
  };
  const shiftStart = toMinutes(company.officeStart || "09:00");
  const shiftEnd = toMinutes(company.officeEnd || "17:00");
  if (shiftEnd <= shiftStart && minutes < shiftEnd) {
    const previous = new Date(`${calendarDate}T00:00:00.000Z`);
    previous.setUTCDate(previous.getUTCDate() - 1);
    asOf = previous.toISOString().slice(0, 10);
  }
  const start = query.start || `${asOf.slice(0, 7)}-01`;
  const end = query.end || asOf;
  const calendar = dates(start, end);
  if (calendar.length > 366)
    throw new ApiError(422, "Choose an attendance range of at most 366 days.");
  const cappedEnd = end < asOf ? end : asOf;
  const selectedDays = start <= cappedEnd ? dates(start, cappedEnd) : [];
  const allDays = [...new Set([...selectedDays, asOf])].sort();
  const holidays = await M.Holiday.find({
    company: companyId,
    date: { $in: allDays },
  })
    .select("date")
    .lean();
  const weekend = Array.isArray(company.weekend) ? company.weekend : [0, 6];
  const holidayDates = new Set(holidays.map((holiday) => holiday.date));
  const workDates = allDays.filter(
    (date) =>
      !weekend.includes(new Date(`${date}T00:00:00.000Z`).getUTCDay()) &&
      !holidayDates.has(date),
  );
  const working = new Set(workDates);
  const match = { company: companyId };
  if (query.employee) match._id = objectId(query.employee, "Employee");
  if (query.department)
    match.department = objectId(query.department, "Department");
  const maxDate = allDays.at(-1);
  match.joinDate = { $lte: maxDate };
  const activeAt = (date) => ({
    joinDate: { $lte: date },
    $or: [
      { exitDate: { $exists: false } },
      { exitDate: null },
      { exitDate: "" },
      { exitDate: { $gt: date } },
    ],
  });
  const inPeriod = { $match: { date: { $gte: start, $lte: cappedEnd } } };
  const historyProject = { $unset: ["isWorkingDay"] };
  const maximumShiftHours = Number.isFinite(company.maxShiftHours)
    ? company.maxShiftHours
    : 20;
  const pipeline = [
    { $match: match },
    ...rowsPipeline(companyId, allDays, workDates, now, maximumShiftHours),
    {
      $facet: {
        summary: [
          inPeriod,
          countsGroup(null),
          ratesStage,
          removeInternalCounts,
          { $unset: "_id" },
        ],
        monthly: [
          inPeriod,
          countsGroup("$date"),
          ratesStage,
          removeInternalCounts,
          { $set: { date: "$_id" } },
          { $unset: "_id" },
          { $sort: { date: 1 } },
        ],
        weekly: [
          inPeriod,
          {
            $set: {
              _week: {
                $dateToString: {
                  format: "%Y-%m-%d",
                  date: {
                    $dateTrunc: {
                      date: { $dateFromString: { dateString: "$date" } },
                      unit: "week",
                      startOfWeek: "monday",
                      timezone: "UTC",
                    },
                  },
                  timezone: "UTC",
                },
              },
            },
          },
          countsGroup("$_week"),
          ratesStage,
          removeInternalCounts,
          { $set: { weekStart: "$_id" } },
          { $unset: "_id" },
          { $sort: { weekStart: 1 } },
        ],
        departments: [
          inPeriod,
          { $set: { _department: "$employee.department" } },
          {
            $group: {
              ...countsGroup("$_department._id").$group,
              name: { $first: "$_department.name" },
            },
          },
          ratesStage,
          removeInternalCounts,
          { $set: { department: "$_id" } },
          { $unset: "_id" },
          { $sort: { name: 1 } },
        ],
        distribution: [
          inPeriod,
          { $group: { _id: "$status", count: { $sum: 1 } } },
          { $project: { _id: 0, status: "$_id", count: 1 } },
          { $sort: { status: 1 } },
        ],
        history: [
          inPeriod,
          { $sort: { date: -1, "employee.name": 1, "employee._id": 1 } },
          { $skip: (query.page - 1) * query.limit },
          { $limit: query.limit },
          historyProject,
        ],
        historyCount: [inPeriod, { $count: "total" }],
        calendar: query.employee
          ? [inPeriod, { $sort: { date: 1 } }, historyProject]
          : [{ $match: { $expr: { $eq: [1, 0] } } }],
        today: [
          { $match: { date: asOf } },
          countsGroup(null),
          ratesStage,
          removeInternalCounts,
          { $unset: "_id" },
        ],
        ownToday: user.employee
          ? [
              {
                $match: {
                  date: asOf,
                  "employee._id": objectId(user.employee, "Employee"),
                },
              },
              { $limit: 1 },
              historyProject,
            ]
          : [{ $match: { $expr: { $eq: [1, 0] } } }],
      },
    },
  ];
  // The independent read-only aggregates use the same explicit company/role scope.
  const [data, headcount, todayHeadcount, departmentOptions, employeeOptions] =
    await Promise.all([
      M.Employee.aggregate(pipeline).allowDiskUse(true),
      M.Employee.aggregate([
        { $match: { ...match, ...activeAt(cappedEnd) } },
        { $count: "total" },
      ]),
      M.Employee.aggregate([
        { $match: { ...match, ...activeAt(asOf) } },
        { $count: "total" },
      ]),
      user.role === "employee"
        ? []
        : M.Department.find({ company: companyId })
            .select("name")
            .sort({ name: 1 })
            .lean(),
      user.role === "employee"
        ? []
        : M.Employee.find({ company: companyId })
            .select("name code department")
            .sort({ name: 1 })
            .limit(500)
            .lean(),
    ]);
  const result = data[0] || {};
  const summary = {
    ...emptyCounts(),
    ...result.summary?.[0],
    totalEmployees: headcount[0]?.total || 0,
  };
  const todayTotals = {
    ...emptyCounts(),
    ...result.today?.[0],
    totalEmployees: todayHeadcount[0]?.total || 0,
  };
  return {
    filters: {
      start,
      end,
      department: query.department || null,
      employee: query.employee || null,
      timezone,
    },
    generatedAt: now.toISOString(),
    summary,
    today: {
      date: asOf,
      calendarDate,
      isWorkingDay: working.has(asOf),
      totals: todayTotals,
      own: result.ownToday?.[0] || null,
    },
    weekly: result.weekly || [],
    monthly: result.monthly || [],
    departments: user.role === "employee" ? [] : result.departments || [],
    distribution: result.distribution || [],
    history: result.history || [],
    calendar: result.calendar || [],
    historyTotal: result.historyCount?.[0]?.total || 0,
    page: query.page,
    limit: query.limit,
    departmentOptions,
    employees: employeeOptions,
    empty:
      summary.expectedDays === 0 &&
      summary.recordedDays === 0 &&
      summary.onLeave === 0,
  };
}

module.exports = { analytics, localDate };
