(ns app.transforms.notes
  "Pure notes/corpus transforms — (state, args) -> state.
   13 transforms for the append-only corpus UI.")

(defn set-notes-entries [state entries]
  (assoc state :notes-entries entries))

(defn add-notes-entry [state entry]
  (update state :notes-entries #(into [entry] %)))

(defn set-notes-selected [state id]
  (assoc state :notes-selected-id id))

(defn set-notes-input [state text]
  (assoc state :notes-input text))

(defn set-notes-loading [state loading?]
  (assoc state :notes-loading? loading?))

(defn set-notes-read-entry [state entry responses]
  (assoc state
         :notes-read-entry entry
         :notes-read-responses responses))

(defn append-notes-response [state response]
  (-> state
      (update :notes-read-responses (fnil conj []) response)
      (update :notes-entries #(into [response] %))))

(defn set-notes-regenerating [state loading?]
  (assoc state :notes-regenerating? loading?))

(defn set-entry-followup-input [state text]
  (assoc state :notes-entry-followup-input text))

(defn set-entry-followup-loading [state loading?]
  (assoc state :notes-entry-followup-loading? loading?))

(defn set-response-followup-loading [state loading?]
  (assoc state :notes-response-followup-loading? loading?))

(defn update-entry-content [state content]
  (assoc-in state [:notes-read-entry :content] content))

(defn update-response-content [state response-id content]
  (update state :notes-read-responses
          (fn [responses]
            (mapv (fn [r]
                    (if (= (:id r) response-id)
                      (assoc r :content content)
                      r))
                  responses))))
