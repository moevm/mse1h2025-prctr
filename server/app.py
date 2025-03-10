import os
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

UPLOAD_FOLDER = "data"
os.makedirs(UPLOAD_FOLDER, exist_ok=True)


@app.route("/start_session", methods=["POST"])
def start_session():
    """Создает новую запись сессии в базе данных"""
    try:
        data = request.json
        student_group = data.get("group")
        last_name = data.get("last_name")
        first_name = data.get("first_name")
        middle_name = data.get("middle_name")

        if not (student_group and last_name and first_name and middle_name):
            return jsonify({"error": "Все поля обязательны"}), 400

        session_start = datetime.utcnow()
        session_id = ObjectId()

        session_data = {
            "_id": session_id,
            "student_group": student_group,
            "last_name": last_name,
            "first_name": first_name,
            "middle_name": middle_name,
            "session_start": session_start,
            "session_end": None,
            "video_id": None,
            "status": "pending"
        }

        sessions_collection.insert_one(session_data)
        return jsonify({"session_id": str(session_id)}), 201

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/upload_video", methods=["POST"])
def upload_video():
    """Обрабатывает загрузку видео с клиента, сохраняет файл и обновляет данные сеанса."""
    try:
        if "video" not in request.files or "id" not in request.form:
            return jsonify({"error": "Отсутствует видеофайл или ID сессии"}), 400

        video = request.files["video"]
        id = request.form["id"]

        session = sessions_collection.find_one({"_id": ObjectId(id)})
        if not session:
            return jsonify({"error": "Сессия не найдена"}), 404

        session_end = datetime.now(timezone.utc)
        extension = os.path.splitext(video.filename)[1] or ".webm"
        video_name = f"{id}_{session['session_start'].strftime('%Y%m%dT%H%M%S')}_{session['surname']}{extension}"
        video_path = os.path.join(UPLOAD_FOLDER, video_name)
        video.save(video_path)

        sessions_collection.update_one(
            {"_id": ObjectId(id)},
            {"$set": {
                "session_end": session_end,
                "video_path": video_path,
                "status": "good"
            }}
        )

        return jsonify({"message": "Видео успешно загружено", "video_path": video_path}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/get/<file_id>', methods=['GET'])
def get_file(file_id):
    try:
        file_data = fs.get(ObjectId(file_id))
        return file_data.read(), 200, {
            'Content-Type': 'video/webm',
            'Content-Disposition': f'attachment; filename={file_data.filename}'
        }
    except gridfs.errors.NoFile:
        return jsonify({"error": "File not found"}), 404


@app.route('/check_sessions', methods=['POST'])
def check_sessions():
    try:
        now = datetime.utcnow()
        pending_sessions = db.sessions.find({"status": "pending"})

        for session in pending_sessions:
            if "session_end" in session and session["session_end"]:
                db.sessions.update_one(
                    {"_id": session["_id"]},
                    {"$set": {"status": "completed"}}
                )
            else:
                db.sessions.update_one(
                    {"_id": session["_id"]},
                    {"$set": {"status": "suspicious"}}
                )

        return jsonify({'message': 'Sessions checked and updated'}), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/get_sessions', methods=['GET'])
def get_sessions():
    try:
        sessions = list(db.sessions.find({}, {"_id": 0}))
        return jsonify(sessions)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
