export const isFmsTaskFullyComplete = (task) => {
  const checklist = Array.isArray(task?.checklist) ? task.checklist : [];
  const createdForm = Array.isArray(task?.createdForm) ? task.createdForm : [];

  // No checklist and no forms => nothing to validate
  if (checklist.length === 0 && createdForm.length === 0) {
    return true;
  }

  const allChecklistDone = checklist.every((item) => item?.completed === true);

  const allMandatoryFormsFilled = createdForm.every((field) => {
    if (!field?.isMandatory) return true;

    const value = task.formData?.[field.fieldName];

    if (value === undefined || value === null) return false;

    if (typeof value === "string" && value.trim() === "") return false;

    if (["file", "image"].includes(field.fieldType)) {
      return typeof value === "object" && !!value?.path;
    }

    if (["date", "datetime"].includes(field.fieldType)) {
      return !isNaN(new Date(value).getTime());
    }

    if (field.fieldType === "number") {
      return !isNaN(Number(value));
    }

    if (field.fieldType === "checkbox") {
      return typeof value === "boolean";
    }

    return true;
  });

  return allChecklistDone && allMandatoryFormsFilled;
};
