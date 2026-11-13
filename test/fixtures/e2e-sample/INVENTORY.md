# Notes app inventory

## S1 · NotesListFragment · "Notes"
| Id | Control | Does | Source | States | Seen |
| --- | --- | --- | --- | --- | --- |
| C1 | description "New note" | opens an empty editor | app/src/main/java/notes/ListFragment.kt:40 | always enabled | yes |
| C2 | text field "Search notes" | filters the list by title | app/src/main/java/notes/ListFragment.kt:62 | empty result shows "No notes found" | yes |
| C3 | list row | opens that note in the editor | app/src/main/java/notes/ListFragment.kt:75 | | yes |

## S2 · NoteEditorFragment · "Edit note"
| Id | Control | Does | Source | States | Seen |
| --- | --- | --- | --- | --- | --- |
| C4 | text "Save" | saves the note and returns to the list | app/src/main/java/notes/EditorFragment.kt:88 | disabled while the title is empty; error "Couldn't save" | yes |
| C5 | description "Delete note" | asks, then deletes the note | app/src/main/java/notes/EditorFragment.kt:120 | confirm dialog "Delete this note?" | no: needs an existing note |
| C6 | description "Share" | hands the note text to the share sheet | app/src/main/java/notes/EditorFragment.kt:141 | | ? |
