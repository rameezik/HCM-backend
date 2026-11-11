const mongoose = require("mongoose");
const { companyPlugin } = require("../services/companyContext");

const { Schema } = mongoose;

const companyUniqueFields = {
  Department: "name",
  Designation: "name",
  LeaveType: "name",
  Holiday: "date",
  Employee: "code",
  Payroll: "month",
};

function reference(modelName, required = true) {
  return {
    type: Schema.Types.ObjectId,
    ref: modelName,
    required,
  };
}

function createModel(modelName, fields, indexes = []) {
  const schema = new Schema(fields, { timestamps: true, strict: "throw" });
  schema.plugin(companyPlugin, { companyModel: modelName === "Company" });

  const uniqueField = companyUniqueFields[modelName];
  if (uniqueField) {
    schema.index({ company: 1, [uniqueField]: 1 }, { unique: true });
  }

  for (const [indexFields, options] of indexes) {
    schema.index(indexFields, options);
  }

  const collection = modelName === "AiLog" ? "ai_logs" : undefined;
  return mongoose.model(modelName, schema, collection);
}

module.exports = { Schema, createModel, reference };
