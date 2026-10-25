const sharp = require("sharp");
const M = require("../models");
const C = require("./context");
const ApiError = require("../utils/ApiError");

const MAX_INPUT_BYTES = 400000;
const MAX_ENCODED_CHARACTERS = 600000;
const MAX_PIXELS = 16000000;
const MAX_EDGE = 512;
let processing = 0;

async function normalizePhoto(dataUrl) {
  if (typeof dataUrl !== "string" || dataUrl.length > MAX_ENCODED_CHARACTERS)
    throw new ApiError(422, "Choose a JPEG, PNG or WebP photo under 400 KB.");
  const match =
    /^data:image\/(jpeg|png|webp);base64,([A-Za-z\d+/]+={0,2})$/.exec(dataUrl);
  if (!match || match[2].length % 4 !== 0)
    throw new ApiError(422, "Provide a valid JPEG, PNG or WebP photo.");
  const input = Buffer.from(match[2], "base64");
  let output;
  try {
    if (
      !input.length ||
      input.length > MAX_INPUT_BYTES ||
      input.toString("base64") !== match[2]
    )
      throw new ApiError(422, "Choose a valid photo under 400 KB.");
    const format = input.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
      ? "jpeg"
      : input
            .subarray(0, 8)
            .equals(
              Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            )
        ? "png"
        : input.toString("ascii", 0, 4) === "RIFF" &&
            input.toString("ascii", 8, 12) === "WEBP"
          ? "webp"
          : null;
    // Reject SVG and other parsers before Sharp inspects untrusted input.
    if (format !== match[1])
      throw new ApiError(
        422,
        "The photo bytes do not match a supported JPEG, PNG or WebP file.",
      );
    if (processing >= 2)
      throw new ApiError(429, "The photo processor is busy. Retry shortly.");
    processing += 1;
    try {
      const image = sharp(input, {
        limitInputPixels: MAX_PIXELS,
        failOn: "warning",
      });
      const metadata = await image.metadata();
      if (
        !["jpeg", "png", "webp"].includes(metadata.format) ||
        metadata.format !== match[1] ||
        !metadata.width ||
        !metadata.height ||
        (metadata.pages || 1) !== 1
      )
        throw new ApiError(
          422,
          "Use a still JPEG, PNG or WebP image matching its declared file type.",
        );
      output = await image
        .rotate()
        .resize({
          width: MAX_EDGE,
          height: MAX_EDGE,
          fit: "inside",
          withoutEnlargement: true,
        })
        .flatten({ background: "#111116" })
        .toColourspace("srgb")
        .jpeg({ quality: 85, mozjpeg: true })
        .toBuffer();
      if (output.length > MAX_INPUT_BYTES)
        throw new ApiError(
          422,
          "The processed photo is too large. Choose a simpler image.",
        );
      return output;
    } finally {
      processing -= 1;
    }
  } catch (error) {
    output?.fill(0);
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      422,
      "This photo could not be decoded. Choose a valid still JPEG, PNG or WebP image up to 16 megapixels.",
    );
  } finally {
    input.fill(0);
  }
}

async function employeeFor(user, employeeId, session, writing = false) {
  const row = await M.Employee.findOne({
    company: user.company,
    $and: [{ _id: employeeId }, C.employeeScope(user)],
  })
    .select("_id user photoUpdatedAt")
    .session(session || null);
  if (!row) throw new ApiError(404, "Employee not found.");
  if (
    writing &&
    user.role === "hr" &&
    String(user.employee) !== String(row._id)
  ) {
    // Lock the linked login so concurrent promotions cannot cross the HR-only
    // ordinary-employee permission boundary during a photo write.
    const filter = { _id: row.user, company: user.company, role: "employee" };
    const linked = session
      ? await M.User.findOneAndUpdate(
          filter,
          { $inc: { __v: 1 } },
          { session, returnDocument: "after" },
        )
      : await M.User.findOne(filter).select("_id");
    if (!linked)
      throw new ApiError(
        403,
        "Admin manages photos for other privileged staff profiles.",
      );
  }
  return row;
}

async function lockActor(user, session) {
  const actor = await M.User.findOneAndUpdate(
    {
      _id: user._id,
      company: user.company,
      active: true,
      role: user.role,
      tokenVersion: user.tokenVersion,
    },
    { $inc: { __v: 1 } },
    { session, returnDocument: "after" },
  );
  if (!actor) throw new ApiError(401, "Your session changed. Sign in again.");
}

async function savePhoto(user, employeeId, dataUrl) {
  // Authorize before doing potentially expensive image decoding.
  await employeeFor(user, employeeId, null, true);
  const photo = await normalizePhoto(dataUrl);
  try {
    return await C.transaction(async (session) => {
      await lockActor(user, session);
      const employee = await employeeFor(user, employeeId, session, true);
      const photoUpdatedAt = new Date();
      await M.Employee.updateOne(
        { _id: employee._id, company: user.company },
        {
          $set: { photo, photoUpdatedAt },
        },
        { session, runValidators: true },
      );
      await C.audit(
        session,
        user,
        "employee_photo_updated",
        "Employee",
        { _id: employee._id, photoUpdatedAt: employee.photoUpdatedAt },
        { _id: employee._id, photoUpdatedAt },
      );
      return {
        photoUpdatedAt,
        photoUrl: `/api/employees/${employee._id}/photo`,
      };
    });
  } finally {
    photo.fill(0);
  }
}

async function readPhoto(user, employeeId) {
  const filter = {
    company: user.company,
    $and: [{ _id: employeeId }, C.employeeScope(user)],
  };
  const row = await M.Employee.findOne(filter).select("+photo");
  if (!row || !row.photo?.length)
    throw new ApiError(404, "Employee photo not found.");
  return Buffer.from(row.photo);
}

async function deletePhoto(user, employeeId) {
  return C.transaction(async (session) => {
    await lockActor(user, session);
    const employee = await employeeFor(user, employeeId, session, true);
    await M.Employee.updateOne(
      { _id: employee._id, company: user.company },
      {
        $unset: { photo: 1 },
        $set: { photoUpdatedAt: null },
      },
      { session },
    );
    await C.audit(
      session,
      user,
      "employee_photo_deleted",
      "Employee",
      { _id: employee._id, photoUpdatedAt: employee.photoUpdatedAt },
      { _id: employee._id, photoUpdatedAt: null },
    );
    return { deleted: true, photoUpdatedAt: null };
  });
}

module.exports = {
  savePhoto,
  readPhoto,
  deletePhoto,
  normalizePhoto,
  MAX_INPUT_BYTES,
  MAX_ENCODED_CHARACTERS,
};
