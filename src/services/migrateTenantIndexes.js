const models = require("../models");
module.exports = async function migrateTenantIndexes() {
  for (const [name, field] of Object.entries({
    Department: "name",
    Designation: "name",
    LeaveType: "name",
    Holiday: "date",
    Employee: "code",
    Payroll: "month",
  })) {
    const collection = models[name].collection;
    // Establish the new constraint before replacing the known legacy constraint.
    await collection.createIndex({ company: 1, [field]: 1 }, { unique: true });
    const indexes = await collection.indexes();
    const legacy = indexes.find(
      (index) =>
        index.name === `${field}_1` &&
        index.unique &&
        Object.keys(index.key).length === 1 &&
        index.key[field] === 1,
    );
    if (legacy) await collection.dropIndex(legacy.name);
  }
};
