export const isFmsTaskFullyComplete = (task) => {
  const checklist = Array.isArray(task?.checklist) ? task.checklist : [];
  const createdForm = Array.isArray(task?.createdForm) ? task.createdForm : [];
  if (checklist.length === 0 && createdForm.length === 0) {
    return false;
  }
  // ✅ 1. Checklist validation (strict like checkbox)
  const allChecklistDone = Array.isArray(task.checklist)
    ? task.checklist.every((item) => item?.completed === true)
    : true; // no checklist = pass

  // ✅ 2. Form validation (strict + type-safe)
  const allMandatoryFormsFilled = Array.isArray(task.createdForm)
    ? task.createdForm.every((field) => {
        if (!field?.isMandatory) return true;

        const value = task.formData?.[field.fieldName];

        // ❌ Missing values
        if (value === undefined || value === null) return false;

        // ❌ Empty string
        if (typeof value === "string" && value.trim() === "") return false;

        // ✅ File / Image validation
        if (["file", "image"].includes(field.fieldType)) {
          return typeof value === "object" && !!value?.path;
        }

        // ✅ Date validation
        if (["date", "datetime"].includes(field.fieldType)) {
          return !isNaN(new Date(value).getTime());
        }

        // ✅ Number validation
        if (field.fieldType === "number") {
          return !isNaN(value);
        }

        // ✅ Boolean allowed
        if (field.fieldType === "checkbox") {
          return typeof value === "boolean";
        }

        return true;
      })
    : true; // no form = pass

  return allChecklistDone && allMandatoryFormsFilled;
};
