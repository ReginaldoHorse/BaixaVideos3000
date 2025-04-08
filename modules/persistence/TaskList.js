const fs = require('fs').promises

class TaskList {
    constructor(paths, manager) {
        this.paths = paths
        this.manager = manager
        this.data = null;
    }

    async save() {
        const taskList = this.manager.getTaskList();
        await fs.writeFile(this.paths.taskList, JSON.stringify(taskList))
    }

    async load() {
        try {
            const res = await fs.readFile(this.paths.taskList)
            this.data = JSON.parse(res)
        } catch(err) {
            console.log("No tasks to restore.")
            return
        }
        if(this.data.length > 0) {
            const toastInfo = {
                type: "task-list",
                title: "Restaurar fila",
                body: `<p>Você gostaria de restaurar ${this.data.length} ${this.data.length > 1 ? "itens" : "item"}<br> que você tinha na fila?</p><button class="btn" data-dismiss="toast" id="tasklist-btn">Restaurar</button><button class="btn" data-dismiss="toast">Cancelar</button>`
            }
            this.manager.window.webContents.send("toast", toastInfo)
        } else {
            console.log("No tasks to restore.")
        }
    }

    restore() {
        this.manager.loadTaskList(this.data)
    }
}

module.exports = TaskList
