import sys
from PyQt5.QtWidgets import QApplication
from gui.main_window import DownloadApp

if __name__ == "__main__":
    app = QApplication(sys.argv)
    window = DownloadApp()
    window.show()
    sys.exit(app.exec_()) 