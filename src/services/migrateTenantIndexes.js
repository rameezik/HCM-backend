const M = require('../models');
module.exports = async function migrateTenantIndexes() {
  for (const [name, field] of Object.entries({Department:'name',Designation:'name',LeaveType:'name',Holiday:'date',Employee:'code',Payroll:'month'})) {
    const collection = M[name].collection;
    // Establish the new constraint before replacing the known legacy constraint.
    await collection.createIndex({company:1,[field]:1},{unique:true});
    const indexes = await collection.indexes();
    const legacy = indexes.find(i=>i.name===`${field}_1` && i.unique && Object.keys(i.key).length===1 && i.key[field]===1);
    if (legacy) await collection.dropIndex(legacy.name);
  }
};
