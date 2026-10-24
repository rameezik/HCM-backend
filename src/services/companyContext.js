const { AsyncLocalStorage } = require("node:async_hooks");
const mongoose = require("mongoose");
const ApiError = require("../utils/ApiError");
const storage = new AsyncLocalStorage();
function withCompany(companyId, work) {
  if (!mongoose.isValidObjectId(companyId))
    throw new ApiError(403, "A company-scoped account is required.");
  return storage.run(
    { companyId: new mongoose.Types.ObjectId(String(companyId)) },
    work,
  );
}
const currentCompany = () => storage.getStore()?.companyId;
function companyPlugin(schema, { companyModel = false } = {}) {
  if (!companyModel)
    schema.add({
      company: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Company",
        index: true,
      },
    });
  schema.pre("validate", function () {
    const companyId = currentCompany();
    if (!companyId || companyModel) return;
    if (this.company && String(this.company) !== String(companyId))
      throw new ApiError(403, "Cross-company writes are not allowed.");
    this.company = companyId;
  });
  schema.pre(/^(find|update|delete|count|distinct)/, function () {
    const companyId = currentCompany();
    if (!companyId) return;
    const constraint = companyModel
      ? { _id: companyId }
      : { company: companyId };
    // Intersect, never overwrite a caller's different ID or company filter.
    this.setQuery({ $and: [this.getFilter(), constraint] });
    if (
      this.op.startsWith("update") ||
      this.op.startsWith("findOneAndUpdate")
    ) {
      const update = this.getUpdate();
      if (update?.company || update?.$set?.company || update?.$unset?.company)
        throw new ApiError(403, "Company ownership cannot be changed.");
    }
  });
  schema.pre("aggregate", function () {
    const companyId = currentCompany();
    if (companyId)
      this.pipeline().unshift({
        $match: companyModel ? { _id: companyId } : { company: companyId },
      });
  });
}
module.exports = { withCompany, currentCompany, companyPlugin };
