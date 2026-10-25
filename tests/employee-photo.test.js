const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const sharp = require("sharp");
const M = require("../src/models");

// Actual generated image files are decoded by Sharp, never substituted API/image
// responses. Every account and photo exists only in an isolated test database.
test(
  "employee profile photos persist as protected normalized MongoDB images",
  { timeout: 60000 },
  async (t) => {
    process.env.JWT_SECRET = crypto.randomBytes(48).toString("hex");
    const dbName = `hcm_test_employee_photo_${process.pid}_${Date.now()}`;
    await mongoose.connect(
      process.env.TEST_MONGODB_URI ||
        "mongodb://127.0.0.1:27017/?replicaSet=hcm",
      { dbName, serverSelectionTimeoutMS: 10000 },
    );
    await Promise.all(Object.values(M).map((model) => model.init()));
    const server = require("../src/app").listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}/api`;
    t.after(async () => {
      await new Promise((resolve) => server.close(resolve));
      assert.match(mongoose.connection.name, /^hcm_test_employee_photo_/);
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    });
    const company = await M.Company.create({
      singleton: `photo-a-${process.pid}`,
      name: "Isolated photo test company A",
    });
    const foreignCompany = await M.Company.create({
      singleton: `photo-b-${process.pid}`,
      name: "Isolated photo test company B",
    });
    const department = await M.Department.create({
      company: company._id,
      name: "Photo fixture department",
    });
    const designation = await M.Designation.create({
      company: company._id,
      name: "Photo fixture role",
    });
    async function account(
      role,
      suffix,
      linked = true,
      targetCompany = company,
    ) {
      const employeeId = linked ? new mongoose.Types.ObjectId() : undefined;
      const user = await M.User.create({
        company: targetCompany._id,
        employee: employeeId,
        name: `Isolated ${suffix}`,
        email: `${suffix}@photo.example.test`,
        role,
        passwordHash: crypto.randomBytes(48).toString("hex"),
        mustChangePassword: false,
      });
      if (linked)
        await M.Employee.create({
          _id: employeeId,
          company: targetCompany._id,
          user: user._id,
          name: user.name,
          email: user.email,
          code: `PHOTO-${suffix}`,
          department: department._id,
          designation: designation._id,
          joinDate: "2020-01-01",
          basic: 100000,
        });
      return user;
    }
    const admin = await account("admin", "admin");
    const hr = await account("hr", "hr");
    const peerHr = await account("hr", "peer-hr");
    const employee = await account("employee", "employee");
    const peer = await account("employee", "peer");
    const foreignAdmin = await account(
      "admin",
      "foreign-admin",
      false,
      foreignCompany,
    );
    const toDataUrl = (bytes, format = "jpeg") =>
      `data:image/${format};base64,${bytes.toString("base64")}`;
    const photoPath = (user) => `/employees/${user.employee}/photo`;
    const fixture = await sharp({
      create: { width: 800, height: 400, channels: 3, background: "#007ba7" },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .withExif({ IFD0: { Artist: "Isolated private photo fixture" } })
      .toBuffer();
    const image = toDataUrl(fixture);
    async function request(user, path, method = "GET", body, expected = 200) {
      const token = user
        ? jwt.sign(
            {
              sub: String(user._id),
              company: String(user.company),
              version: user.tokenVersion,
            },
            process.env.JWT_SECRET,
            { algorithm: "HS256", expiresIn: "1h" },
          )
        : null;
      const response = await fetch(base + path, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const isImage = response.headers
        .get("content-type")
        ?.startsWith("image/jpeg");
      const data = isImage
        ? Buffer.from(await response.arrayBuffer())
        : await response.json();
      assert.equal(
        response.status,
        expected,
        `${method} ${path}: ${isImage ? "image/jpeg" : data.message || response.statusText}`,
      );
      return { data, headers: response.headers };
    }
    await t.test(
      "authenticated upload normalizes orientation, size and metadata before persistent storage",
      async () => {
        await request(null, photoPath(employee), "POST", { image }, 401);
        await request(employee, photoPath(employee), "GET", undefined, 404);
        const saved = (
          await request(admin, photoPath(employee), "POST", { image })
        ).data;
        assert.ok(saved.photoUpdatedAt);
        assert.equal(saved.photoUrl, "/api" + photoPath(employee));
        const fetched = await request(employee, photoPath(employee));
        assert.match(fetched.headers.get("cache-control"), /private.*no-store/);
        assert.equal(fetched.headers.get("x-content-type-options"), "nosniff");
        const metadata = await sharp(fetched.data).metadata();
        assert.equal(metadata.format, "jpeg");
        assert.equal(metadata.width, 256);
        assert.equal(metadata.height, 512);
        assert.equal(metadata.orientation, undefined);
        assert.equal(metadata.exif, undefined);
        assert.equal(metadata.icc, undefined);
        const stored = await M.Employee.findById(employee.employee).select(
          "+photo",
        );
        assert.equal(Buffer.isBuffer(stored.photo), true);
        assert.deepEqual(Buffer.from(stored.photo), fetched.data);
        assert.ok(stored.photoUpdatedAt);
        assert.equal(await M.BiometricEnrollment.countDocuments(), 0);
      },
    );
    await t.test(
      "ordinary employee JSON, attendance analytics and audit logs never expose stored photo bytes",
      async () => {
        const ordinary = await M.Employee.findById(employee.employee).lean();
        assert.equal(ordinary.photo, undefined);
        assert.ok(ordinary.photoUpdatedAt);
        const listing = (await request(admin, "/employees")).data;
        const detail = (
          await request(employee, `/employees/${employee.employee}`)
        ).data;
        const analytics = (await request(admin, "/attendance/analytics")).data;
        const audit = await M.AuditLog.find({ company: company._id }).lean();
        for (const data of [listing, detail, analytics, audit]) {
          const encoded = JSON.stringify(data);
          assert.equal(encoded.includes(fixture.toString("base64")), false);
          assert.equal(encoded.includes('"photo":'), false);
          assert.equal(
            encoded.includes("Isolated private photo fixture"),
            false,
          );
        }
        assert.ok(audit.some((row) => row.action === "employee_photo_updated"));
      },
    );
    await t.test(
      "self-service, HR and Admin permissions respect employee roles and company boundaries",
      async () => {
        await request(employee, photoPath(employee), "POST", { image });
        await request(employee, photoPath(peer), "POST", { image }, 404);
        await request(employee, photoPath(peer), "GET", undefined, 404);
        await request(hr, photoPath(peer), "POST", { image });
        await request(hr, photoPath(hr), "POST", { image });
        await request(hr, photoPath(admin), "POST", { image }, 403);
        await request(hr, photoPath(peerHr), "DELETE", undefined, 403);
        await request(hr, photoPath(employee));
        await request(foreignAdmin, photoPath(employee), "GET", undefined, 404);
        await request(
          foreignAdmin,
          photoPath(employee),
          "POST",
          { image },
          404,
        );
        await request(
          foreignAdmin,
          photoPath(employee),
          "DELETE",
          undefined,
          404,
        );
      },
    );
    await t.test(
      "invalid, mismatched, animated and oversized images fail without changing the saved photo",
      async () => {
        const before = (await request(employee, photoPath(employee))).data;
        await request(
          employee,
          photoPath(employee),
          "POST",
          {
            image: toDataUrl(
              Buffer.from(
                '<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="20"/></svg>',
              ),
              "png",
            ),
          },
          422,
        );
        await request(
          employee,
          photoPath(employee),
          "POST",
          {
            image:
              "data:image/jpeg;base64," +
              Buffer.alloc(410000, 255).toString("base64"),
          },
          422,
        );
        await request(
          employee,
          photoPath(employee),
          "POST",
          { image: "data:image/jpeg;base64," + "A".repeat(600000) },
          422,
        );
        const png = await sharp({
          create: { width: 10, height: 10, channels: 3, background: "#cc3466" },
        })
          .png()
          .toBuffer();
        await request(
          employee,
          photoPath(employee),
          "POST",
          { image: toDataUrl(png, "jpeg") },
          422,
        );
        const frames = Buffer.alloc(20 * 40 * 3);
        for (let pixel = 0; pixel < 800; pixel++)
          frames[pixel * 3 + (pixel < 400 ? 0 : 2)] = 255;
        const animated = await sharp(frames, {
          raw: { width: 20, height: 40, channels: 3, pageHeight: 20 },
        })
          .webp({ loop: 0, delay: [100, 100] })
          .toBuffer();
        assert.equal((await sharp(animated).metadata()).pages, 2);
        await request(
          employee,
          photoPath(employee),
          "POST",
          { image: toDataUrl(animated, "webp") },
          422,
        );
        const huge = await sharp({
          create: {
            width: 4100,
            height: 4000,
            channels: 3,
            background: "#111116",
          },
        })
          .png()
          .toBuffer();
        await request(
          employee,
          photoPath(employee),
          "POST",
          { image: toDataUrl(huge, "png") },
          422,
        );
        const after = (await request(employee, photoPath(employee))).data;
        assert.deepEqual(after, before);
      },
    );
    await t.test(
      "PNG and WebP replacement saves fresh JPEG bytes and deletion survives subsequent reads",
      async () => {
        const png = await sharp({
          create: {
            width: 200,
            height: 100,
            channels: 4,
            background: { r: 230, g: 80, b: 110, alpha: 0.5 },
          },
        })
          .png()
          .toBuffer();
        const first = (
          await request(employee, photoPath(employee), "POST", {
            image: toDataUrl(png, "png"),
          })
        ).data;
        const firstImage = (await request(employee, photoPath(employee))).data;
        assert.equal((await sharp(firstImage).metadata()).format, "jpeg");
        const webp = await sharp({
          create: {
            width: 300,
            height: 300,
            channels: 3,
            background: "#336699",
          },
        })
          .webp()
          .toBuffer();
        const replaced = (
          await request(employee, photoPath(employee), "POST", {
            image: toDataUrl(webp, "webp"),
          })
        ).data;
        assert.ok(
          Date.parse(replaced.photoUpdatedAt) >=
            Date.parse(first.photoUpdatedAt),
        );
        assert.notDeepEqual(
          (await request(employee, photoPath(employee))).data,
          firstImage,
        );
        const removed = (await request(employee, photoPath(employee), "DELETE"))
          .data;
        assert.equal(removed.deleted, true);
        assert.equal(removed.photoUpdatedAt, null);
        await request(employee, photoPath(employee), "GET", undefined, 404);
        const stored = await M.Employee.findById(employee.employee)
          .select("+photo")
          .lean();
        assert.equal(stored.photo, undefined);
        assert.equal(stored.photoUpdatedAt, null);
        assert.equal(
          (await request(employee, photoPath(employee), "DELETE")).data.deleted,
          true,
        );
      },
    );
  },
);
