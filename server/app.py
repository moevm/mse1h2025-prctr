import json
import os
import time
from flask import Flask, request, Response, jsonify, render_template, abort, send_from_directory
from werkzeug.security import safe_join 
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

DATA_FOLDER = "/app/" + UPLOAD_FOLDER


@app.route("/start_session", methods=["POST"])
def start_session():
    """Создает новую запись сессии в базе данных"""
    try:
        data = request.form
        group = data.get("group")
        surname = data.get("surname")
        name = data.get("name")
        patronymic = data.get("patronymic")
        link = data.get("link")

        if not (group and surname and name and patronymic and link):
            return jsonify({"error": "Поля 'group', 'surname', 'name', 'patronymic', 'link' обязательны для заполнения"}), 400

        session_start = datetime.now(timezone.utc)
        # Форматирование даты
        session_date_start, session_time_start = session_start.strftime("%Y-%m-%d %H:%M:%S").split()
        id = ObjectId()

        session_data = {
            "_id": id,
            "group": group,
            "surname": surname,
            "name": name,
            "patronymic": patronymic,
            "link": link,
            "session_date_start": session_date_start,
            "session_time_start": session_time_start,
            "session_date_end": None,
            "session_time_end": None,
            "screen_video_path": None,
            "camera_video_path": None,
            "status": None,
            "metadata": None,
            "logs_path": None
        }

        sessions_collection.insert_one(session_data)
        return jsonify({"id": str(id)}), 201

    except Exception as e:
        return jsonify({"error": str(e)}), 500

progress_store = {}

@app.route("/progress/<id>")
def sse_progress(id):
    def event_stream():
        while True:
            progress = progress_store.get(id, {"step": 0, "message": "Ожидание запроса"})
            yield f"data: {json.dumps(progress)}\n\n"
            if progress["step"] == 7:
                del progress_store[id]
                break
            time.sleep(1)
    
    return Response(
        event_stream(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache"
        }
    )

def convert_user_time_to_utc(user_time_str, user_time_offset):
    user_time = datetime.strptime(user_time_str, "%Y-%m-%dT%H:%M:%S")
    user_time_utc = user_time + user_time_offset
    return user_time_utc.strftime("%Y%m%dT%H%M%S") 

@app.route("/upload_video", methods=["POST"])
def upload_video():
    """Обрабатывает загрузку видео с клиента, сохраняет файл и обновляет данные сеанса."""
    try:
        if "screen_video" not in request.files or "camera_video" not in request.files or "id" not in request.form:
            return jsonify({"error": "Отсутствует видеофайл или ID сессии"}), 400
        
        id = request.form["id"]
        
        progress_store[id] = {"step": 1, "message": "Начало обработки данных"}
        
        screen_video = request.files.getlist("screen_video")
        camera_video = request.files.getlist("camera_video")
        
        metadata = json.loads(request.form["metadata"])

        progress_store[id] = {"step": 2, "message": "Метаданные получены"}

        session = sessions_collection.find_one({"_id": ObjectId(id)})
        if not session:
            progress_store[id] = {"step": -1, "message": "Сессия не найдена"}
            return jsonify({"error": "Сессия не найдена"}), 404

        session_end = datetime.now(timezone.utc)
        session_date_end, session_time_end = session_end.strftime("%Y-%m-%d %H:%M:%S").split()
        
        screen_video_paths: list[str] = []
        camera_video_paths: list[str] = []

        session_start_utc = datetime.strptime(
            f"{session['session_date_start']}T{session['session_time_start']}",
            "%Y-%m-%dT%H:%M:%S"
        ).replace(tzinfo=timezone.utc)

        user_time_str = os.path.splitext(screen_video[0].filename)[0].split('_')[-1]
        user_time = datetime.strptime(user_time_str, "%Y-%m-%dT%H:%M:%S") 
        user_time_offset = session_start_utc - user_time.replace(tzinfo=timezone.utc)

        for video in screen_video:
            root, ext = os.path.splitext(video.filename)
            user_time_str = root.split('_')[-1]
            user_time_utc = convert_user_time_to_utc(user_time_str, user_time_offset)
            
            screen_extension = ext or ".mp4"
            screen_video_name = f"{id}_screen_{user_time_utc}_{session['surname']}{screen_extension}"
            screen_video_path = os.path.join(UPLOAD_FOLDER, screen_video_name)
            
            video.save(screen_video_path)
            screen_video_paths.append(screen_video_path)
        
        progress_store[id] = {"step": 3, "message": "Получены и сохранены записи экрана"}
        
        for video in camera_video:
            root, ext = os.path.splitext(video.filename)
            user_time_str = root.split('_')[-1]
            user_time_utc = convert_user_time_to_utc(user_time_str, user_time_offset)
            
            camera_extension = ext or ".mp4"
            camera_video_name = f"{id}_camera_{user_time_utc}_{session['surname']}{camera_extension}"
            camera_video_path = os.path.join(UPLOAD_FOLDER, camera_video_name)
            
            video.save(camera_video_path)
            camera_video_paths.append(camera_video_path)

        progress_store[id] = {"step": 4, "message": "Получены и сохранены записи камеры"}

        logs_file = request.files.get("logs")
        if logs_file:
            logs_extension = os.path.splitext(logs_file.filename)[1] or ".json"
            logs_file_name = f"{id}_logs_{session['session_date_start'].replace('-', '')}T{session['session_time_start'].replace(':', '')}_{session['surname']}{logs_extension}"
            logs_file_path = os.path.join(UPLOAD_FOLDER, logs_file_name)
            logs_file.save(logs_file_path)

            progress_store[id] = {"step": 5, "message": "Получены и сохранены логи"}
        else:
            progress_store[id] = {"step": 5, "message": "Логи не были получены"}
            logs_file_path = None

        status = 'good'
        if (len(screen_video_paths) > 1 or len(camera_video_paths) > 1): 
            progress_store[id] = {"step": 6, "message": f"Статус записи плохой: получено {len(screen_video_paths)} записей экрана и {len(camera_video_paths)} записей камеры"}
            status = 'bad'

        sessions_collection.update_one(
            {"_id": ObjectId(id)},
            {"$set": {
                "session_date_end": session_date_end,
                "session_time_end": session_time_end,
                "screen_video_path": screen_video_paths,
                "camera_video_path": camera_video_paths,
                "status": status,
                "metadata": metadata,
                "logs_path": logs_file_path
            }}
        )
        progress_store[id] = {"step": 7, "message": "Данные загружены в базу данных"}

        return jsonify({"message": "Видео и логи успешно загружены", "screen_video_paths": screen_video_paths, "camera_video_paths": camera_video_paths, "logs_path": logs_file_path}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/")
def search_page():
    """Отображает страницу поиска."""
    return render_template("filter.html")

@app.route("/results")
def results_page():
    """Отображает страницу результатов."""
    return render_template("filter_result.html")


@app.route("/get_sessions", methods=["GET"])
def get_sessions():
    """Получение сессий с фильтрацией."""
    try:
        query = {}
        group = request.args.get("group")
        surname = request.args.get("surname")
        name = request.args.get("name")
        patronymic = request.args.get("patronymic")
        session_date_start = request.args.get("date")

        if group:
            query["group"] = group
        if surname:
            query["surname"] = surname
        if name:
            query["name"] = name
        if patronymic:
            query["patronymic"] = patronymic
        if session_date_start:
            query["session_date_start"] = session_date_start

        sessions = list(sessions_collection.find(query))

        if not sessions:
            return jsonify([])

        result = [
            {
                **{"id": str(session["_id"])},  # Преобразуем _id в id
                **{key: session.get(key) for key in session if key != "_id"}  # Копируем остальные поля
            }
            for session in sessions
        ]

        return jsonify(result)

    except Exception as e:
        return jsonify({"error": str(e)}), 500
    
ALLOWED_EXTENSIONS = {'.mp4', '.json'}

@app.route("/open/<path:filename>")
def open_file(filename):
    if not any(filename.endswith(ext) for ext in ALLOWED_EXTENSIONS):
        abort(403)
        
    safe_path = safe_join(DATA_FOLDER, filename)
    
    if safe_path is None or not os.path.isfile(safe_path):
        abort(404)
        
    return send_from_directory(DATA_FOLDER, filename, as_attachment=False)


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
