from flask import Flask, request, jsonify
from pymongo import MongoClient
import gridfs
from bson import ObjectId
from flask_cors import CORS
from datetime import datetime, timezone

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})

client = MongoClient('mongodb://mongo-db:27017/')
db = client["video_database"]
fs = gridfs.GridFS(db)  # Используем GridFS для работы с файлами
sessions_collection = db["sessions"]


def parse_time(time: str):
    # 24-2-2025T12-51-55
    time = time.split('T')
    date = list(map(int, time[0].split('-')))
    time = list(map(int, time[1].split('-')))
    date_time = {
        'D': date[0],
        'M': date[1],
        'Y': date[2],
        'h': time[0],
        'm': time[1],
        's': time[2]
    }
    return date_time


@app.route("/start_session", methods=["POST"])
def start_session():
    """Создает новую запись сессии в базе данных"""
    try:
        data = request.form
        group = data.get("group")
        surname = data.get("surname")
        name = data.get("name")
        patronymic = data.get("patronymic")

        if not (group and surname and name and patronymic):
            return jsonify({"error": "Поля 'group', 'surname', 'name', 'patronymic' обязательны для заполнения"}), 400

        session_start = datetime.now(timezone.utc)
        id = ObjectId()

        session_data = {
            "_id": id,
            "group": group,
            "surname": surname,
            "name": name,
            "patronymic": patronymic,
            "session_start": session_start,
            "session_end": None,
            "video_path": None,
            "status": None
        }

        sessions_collection.insert_one(session_data)
        return jsonify({"id": str(id)}), 201

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/upload', methods=['POST'])
def upload_file():
    file = request.files['file']
    username = request.form['username']
    start = parse_time(request.form['start'])
    end = parse_time(request.form['end'])
    file_id = fs.put(file.read(), filename=file.filename, metadata={
        'username': username, 'start': start, 'end': end})
    return jsonify({"file_id": str(file_id)}), 200


@app.route('/get_sessions', methods=['GET'])
def get_sessions():
    try:
        sessions = list(db.sessions.find({}, {"_id": 0}))
        return jsonify(sessions)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# @app.route('/get/<file_id>', methods=['GET'])
# def get_file(file_id):
#     try:
#         file_data = fs.get(ObjectId(file_id))
#         return file_data.read(), 200, {
#             'Content-Type': 'video/webm',
#             'Content-Disposition': f'attachment; filename={file_data.filename}'
#         }
#     except gridfs.errors.NoFile:
#         return jsonify({"error": "File not found"}), 404


# @app.route('/check_sessions', methods=['POST'])
# def check_sessions():
#     try:
#         now = datetime.now(timezone.utc)
#         pending_sessions = db.sessions.find({"status": "pending"})

#         for session in pending_sessions:
#             if "session_end" in session and session["session_end"]:
#                 db.sessions.update_one(
#                     {"_id": session["_id"]},
#                     {"$set": {"status": "completed"}}
#                 )
#             else:
#                 db.sessions.update_one(
#                     {"_id": session["_id"]},
#                     {"$set": {"status": "suspicious"}}
#                 )

#         return jsonify({'message': 'Sessions checked and updated'}), 200
#     except Exception as e:
#         return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
