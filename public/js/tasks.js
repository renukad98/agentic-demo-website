// Task content stays in memory and is always rendered as text, never HTML.
export function initTasks(doc, fetcher = globalThis.fetch.bind(globalThis)) {
  const root = doc.querySelector("#task-root");
  if (!root) return null;
  const form = doc.querySelector("#task-form");
  const submit = doc.querySelector("#task-submit");
  const cancelEdit = doc.querySelector("#task-edit-cancel");
  const status = doc.querySelector("#task-status");
  const list = doc.querySelector("#task-list");
  const loading = doc.querySelector("#task-loading");
  const empty = doc.querySelector("#task-empty");
  const search = doc.querySelector("#task-search");
  const noMatches = doc.querySelector("#task-no-matches");
  const dialog = doc.querySelector("#task-delete-dialog");
  const clearCompleted = doc.querySelector("#task-clear-completed");
  const deleteCompleted = Symbol("delete completed tasks");
  const win = doc.defaultView;
  const events = new win.AbortController();
  let cardEvents = new win.AbortController();
  const listen = (node, event, fn) =>
    node.addEventListener(event, fn, { signal: events.signal });
  let csrf;
  let tasks = [];
  let listLoaded = false;
  let editing = null;
  let deleting = null;
  let deleteTrigger = null;
  let busy = false;
  let expired = false;
  let revision = 0;
  const fields = ["title", "description", "priority", "dueDate"];
  const control = (name) => form.elements.namedItem(name);
  function clearErrors() {
    for (const name of fields) {
      control(name).removeAttribute("aria-invalid");
      doc.querySelector(`#task-${name}-error`).textContent = "";
    }
  }
  function fieldErrors(errors) {
    for (const name of fields) {
      if (errors?.[name]?.length) {
        control(name).setAttribute("aria-invalid", "true");
        doc.querySelector(`#task-${name}-error`).textContent =
          errors[name].join(" ");
      }
    }
    form.querySelector('[aria-invalid="true"]')?.focus();
  }
  function resetEditor() {
    editing = null;
    form.reset();
    clearErrors();
    submit.textContent = "Create task";
    doc.querySelector("#task-form-heading").textContent = "Create a task";
    cancelEdit.hidden = true;
  }
  function expire() {
    expired = true;
    revision++;
    tasks = [];
    listLoaded = false;
    search.value = "";
    empty.hidden = true;
    noMatches.hidden = true;
    cardEvents.abort();
    list.replaceChildren();
    resetEditor();
    deleting = null;
    if (dialog.open) dialog.close();
    doc.querySelector("#task-workspace").hidden = true;
    doc.querySelector("#task-login").hidden = false;
    status.textContent = "Your session has expired. Please log in again.";
  }
  async function api(path, method = "GET", body) {
    const options = { method, headers: {} };
    if (method !== "GET") {
      if (!csrf) {
        const response = await fetcher("/api/csrf", { cache: "no-store" });
        if (!response.ok)
          throw new Error("Unable to establish a secure session.");
        csrf = (await response.json()).token;
      }
      options.headers = {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf,
      };
      if (body !== undefined) options.body = JSON.stringify(body);
    }
    let response;
    let data;
    try {
      response = await fetcher(path, { ...options, cache: "no-store" });
      data = await response.json();
    } catch {
      const error = new Error("Unable to read the server response.");
      error.uncertain = method !== "GET" && (!response || response.ok);
      throw error;
    }
    if (!response.ok) {
      if (response.status === 403) {
        csrf = undefined;
        // CSRF runs before authentication on the server. Never replay a write:
        // safely check whether a rejected old token reflects an expired session.
        try {
          const auth = await fetcher("/api/auth/me", { cache: "no-store" });
          if (auth.status === 401) expire();
        } catch {
          /* An unavailable check cannot grant access or replay the write. */
        }
      }
      if (response.status === 401) expire();
      const error = new Error(
        expired
          ? "Your session has expired. Please log in again."
          : data.error?.message || "Request failed.",
      );
      error.fields = data.error?.fields;
      throw error;
    }
    return data;
  }
  const text = (tag, value, className) => {
    const node = doc.createElement(tag);
    node.textContent = value;
    if (className) node.className = className;
    return node;
  };
  function action(label, fn) {
    const button = text("button", label, "secondary");
    button.type = "button";
    button.disabled = busy;
    button.addEventListener("click", fn, { signal: cardEvents.signal });
    return button;
  }
  function render() {
    cardEvents.abort();
    cardEvents = new win.AbortController();
    list.replaceChildren();
    clearCompleted.hidden = !tasks.some((task) => task.status === "Completed");
    const query = search.value.trim().toLowerCase();
    const visibleTasks = query
      ? tasks.filter((task) => task.title.toLowerCase().includes(query))
      : tasks;
    const showListState = listLoaded && !expired;
    empty.hidden = !showListState || Boolean(query) || tasks.length !== 0;
    noMatches.hidden = !showListState || !query || visibleTasks.length !== 0;
    for (const task of visibleTasks) {
      const item = doc.createElement("li");
      const article = doc.createElement("article");
      article.className = "card task-card";
      const title = text("h3", task.title);
      title.id = `task-heading-${task.id}`;
      article.setAttribute("aria-labelledby", title.id);
      article.dataset.taskId = task.id;
      article.append(title, text("p", task.description, "task-description"));
      article.append(
        text("p", `${task.priority} priority · ${task.status}`, "task-meta"),
      );
      article.append(
        text(
          "p",
          task.dueDate ? `Due: ${task.dueDate}` : "No due date",
          "task-meta",
        ),
      );
      article.append(
        text(
          "p",
          `Created: ${new Date(task.createdAt).toLocaleString()} · Updated: ${new Date(task.updatedAt).toLocaleString()}`,
          "task-dates",
        ),
      );
      const actions = doc.createElement("div");
      actions.className = "task-actions";
      actions.append(
        action("Edit", () => {
          editing = task;
          clearErrors();
          for (const name of fields) control(name).value = task[name] ?? "";
          submit.textContent = "Save changes";
          doc.querySelector("#task-form-heading").textContent = "Edit task";
          cancelEdit.hidden = false;
          control("title").focus();
        }),
      );
      actions.append(
        action(task.status === "Pending" ? "Complete" : "Reopen", () =>
          changeStatus(task),
        ),
      );
      actions.append(
        action("Delete", (event) => {
          openDelete(
            task,
            event.currentTarget,
            "Permanently delete task?",
            `Delete “${task.title}”?`,
          );
        }),
      );
      article.append(actions);
      item.append(article);
      list.append(item);
    }
  }
  function setBusy(value) {
    busy = value;
    submit.disabled = value;
    cancelEdit.disabled = value;
    doc.querySelector("#task-refresh").disabled = value;
    clearCompleted.disabled = value;
    for (const button of list.querySelectorAll("button"))
      button.disabled = value;
    doc.querySelector("#task-delete-confirm").disabled = value;
    doc.querySelector("#task-delete-cancel").disabled = value;
  }
  async function load() {
    if (expired) return false;
    const ownRevision = ++revision;
    listLoaded = false;
    loading.hidden = false;
    root.setAttribute("aria-busy", "true");
    empty.hidden = true;
    noMatches.hidden = true;
    try {
      const data = await api("/api/tasks");
      if (ownRevision !== revision || expired) return false;
      tasks = data.tasks;
      listLoaded = true;
      render();
      return true;
    } catch (error) {
      if (!expired && ownRevision === revision)
        status.textContent = `Unable to load tasks. ${error.message} Use Refresh tasks to retry.`;
      return false;
    } finally {
      if (ownRevision === revision || expired) {
        loading.hidden = true;
        root.setAttribute("aria-busy", "false");
      }
    }
  }
  async function changeStatus(task) {
    if (busy || expired) return;
    setBusy(true);
    try {
      const next = task.status === "Pending" ? "Completed" : "Pending";
      await api(`/api/tasks/${task.id}/status`, "PATCH", { status: next });
      if (expired) return;
      status.textContent =
        next === "Completed" ? "Task completed." : "Task reopened.";
      await load();
    } catch (error) {
      if (!expired) status.textContent = error.message;
    } finally {
      setBusy(false);
    }
  }
  listen(form, "submit", async (event) => {
    event.preventDefault();
    if (busy || expired) return;
    clearErrors();
    const body = Object.fromEntries(
      fields.map((name) => [name, control(name).value]),
    );
    body.title = body.title.trim();
    if (control("dueDate").validity.badInput) {
      fieldErrors({
        dueDate: ["Enter a complete valid due date or clear the field."],
      });
      status.textContent = "Check the due date.";
      return;
    }
    if (!body.title) {
      fieldErrors({ title: ["Enter a task title."] });
      status.textContent = "Check the task title.";
      return;
    }
    const current = editing;
    const payload = current
      ? Object.fromEntries(
          fields
            .filter((name) => body[name] !== (current[name] ?? ""))
            .map((name) => [name, body[name]]),
        )
      : body;
    if (current && Object.keys(payload).length === 0) {
      resetEditor();
      status.textContent = "No changes to save.";
      return;
    }
    setBusy(true);
    status.textContent = "Saving task…";
    try {
      await api(
        current ? `/api/tasks/${current.id}` : "/api/tasks",
        current ? "PATCH" : "POST",
        payload,
      );
      if (expired) return;
      resetEditor();
      status.textContent = current ? "Task changes saved." : "Task created.";
      await load();
    } catch (error) {
      if (expired) return;
      fieldErrors(error.fields);
      status.textContent =
        !current && error.uncertain
          ? "The save outcome is uncertain. Check your task list before retrying."
          : error.message;
    } finally {
      setBusy(false);
    }
  });
  listen(cancelEdit, "click", () => {
    resetEditor();
    control("title").focus();
  });
  listen(doc.querySelector("#task-refresh"), "click", () => {
    status.textContent = "";
    void load();
  });
  listen(search, "input", () => {
    if (!expired) render();
  });
  function openDelete(selection, trigger, heading, message) {
    if (busy || expired || dialog.open) return;
    deleting = selection;
    deleteTrigger = trigger;
    doc.querySelector("#task-delete-heading").textContent = heading;
    doc.querySelector("#task-delete-message").textContent = message;
    dialog.showModal();
  }
  listen(clearCompleted, "click", () => {
    if (clearCompleted.hidden) return;
    openDelete(
      deleteCompleted,
      clearCompleted,
      "Clear completed tasks?",
      "All your completed tasks will be permanently deleted.",
    );
  });
  const closeDelete = () => {
    deleting = null;
    dialog.close();
    deleteTrigger?.focus();
  };
  listen(doc.querySelector("#task-delete-cancel"), "click", closeDelete);
  listen(dialog, "cancel", (event) => {
    event.preventDefault();
    if (!busy) closeDelete();
  });
  listen(doc.querySelector("#task-delete-confirm"), "click", async () => {
    if (busy || expired || !deleting) return;
    const selected = deleting;
    setBusy(true);
    try {
      if (selected === deleteCompleted) {
        const { deletedIds } = await api("/api/tasks/completed", "DELETE");
        if (expired) return;
        const deleted = new Set(deletedIds);
        tasks = tasks.filter((task) => !deleted.has(task.id));
        if (editing && deleted.has(editing.id)) resetEditor();
        render();
        status.textContent = deleted.size
          ? "Completed tasks permanently deleted."
          : "There were no completed tasks to delete.";
      } else {
        await api(`/api/tasks/${selected.id}`, "DELETE");
        if (expired) return;
        if (editing?.id === selected.id) resetEditor();
        status.textContent = "Task permanently deleted.";
      }
      deleting = null;
      dialog.close();
      await load();
      if (!expired) doc.querySelector("#task-list-heading").focus();
    } catch (error) {
      if (expired) return;
      deleting = null;
      if (dialog.open) dialog.close();
      status.textContent =
        selected === deleteCompleted && error.uncertain
          ? "The deletion outcome is uncertain. Refresh tasks before retrying."
          : error.message;
      if (selected === deleteCompleted) {
        setBusy(false);
        clearCompleted.focus();
      }
    } finally {
      setBusy(false);
    }
  });
  listen(win, "pageshow", (event) => {
    if (event.persisted && !busy) void load();
  });
  const ready = load();
  return {
    ready,
    reload: load,
    dispose: () => {
      revision++;
      events.abort();
      cardEvents.abort();
      tasks = [];
    },
  };
}

if (typeof document !== "undefined" && document.querySelector("#task-root"))
  initTasks(document);
