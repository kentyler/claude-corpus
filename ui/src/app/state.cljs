(ns app.state
  "Core application state for Corpus.
   Minimal — notes, config, error/loading, and helpers."
  (:require [reagent.core :as r]
            [cljs-http.client :as http]
            [cljs.core.async :refer [go <!]]))

;; ============================================================
;; API base URL
;; ============================================================

(def api-base (str (.-protocol js/location) "//" (.-host js/location)))

;; ============================================================
;; Application state atom
;; ============================================================

(defonce app-state
  (r/atom {;; Page navigation
           :current-page :notes

           ;; Notes/corpus state
           :notes-entries []
           :notes-selected-id nil
           :notes-input ""
           :notes-loading? false
           :notes-read-entry nil
           :notes-read-responses []
           :notes-regenerating? false
           :notes-entry-followup-input ""
           :notes-entry-followup-loading? false
           :notes-response-followup-loading? false

           ;; App configuration (loaded from settings/config.json)
           :config {}

           ;; UI state
           :loading? false
           :error nil}))

;; ============================================================
;; Error helpers
;; ============================================================

(defn set-error! [message]
  (swap! app-state assoc :error message))

(defn clear-error! []
  (swap! app-state assoc :error nil))

;; ============================================================
;; Event logging
;; ============================================================

(defn log-event!
  "Log an event to the server"
  ([event-type message] (log-event! event-type message nil nil))
  ([event-type message source] (log-event! event-type message source nil))
  ([event-type message source details]
   (go
     (<! (http/post (str api-base "/api/events")
                    {:json-params {:event_type event-type
                                   :source (or source "ui")
                                   :message message
                                   :details details}})))))

(defn log-error!
  "Log an error and display it in the UI"
  ([message] (log-error! message nil nil))
  ([message source] (log-error! message source nil))
  ([message source details]
   (set-error! message)
   (log-event! "error" message source details)))

;; ============================================================
;; Config
;; ============================================================

(defn load-config!
  "Load app configuration from settings/config.json"
  []
  (go
    (let [response (<! (http/get (str api-base "/api/config")))]
      (if (:success response)
        (let [config (:body response)]
          (swap! app-state assoc :config config))
        (log-event! "warning" "Could not load config — using defaults" "load-config")))))

(defn save-config!
  "Save app configuration to settings/config.json"
  []
  (go
    (let [config (:config @app-state)
          response (<! (http/put (str api-base "/api/config")
                                 {:json-params config}))]
      (when-not (:success response)
        (log-error! "Failed to save configuration" "save-config" {:response (:body response)})))))

;; ============================================================
;; Initialization
;; ============================================================

(defn init! []
  (load-config!))
