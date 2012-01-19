/*
 * Copyright 2011 Adobe Systems Incorporated. All Rights Reserved.
 */

/**
 * DocumentManager is the model for the set of currently 'open' files and their contents. It controls
 * which file is currently shown in the editor, the dirty bit for all files, and the list of documents
 * in the working set.
 * 
 * Each Document also encapsulates the editor widget for that file, which in turn controls each file's
 * contents and undo history. (So this is not a perfectly clean, headless model, but that's unavoidable
 * because the document state is tied up in the CodeMirror UI). We share ownership of the editor objects
 * with EditorManager, which creates, shows/hides, resizes, and disposes the editors.
 *
 * This module dispatches several events:
 *    - dirtyFlagChange -- When any Document's isDirty flag changes. The 2nd arg to the listener is the
 *      Document whose flag changed.
 *    - currentDocumentChange -- When the value of getCurrentDocument() changes.
 *    - workingSetAdd -- When a Document is added to the working set (see getWorkingSet()). The 2nd arg
 *      to the listener is the added Document.
 *    - workingSetRemove -- When a Document is removed from the working set (see getWorkingSet()). The
 *      2nd arg to the listener is the removed Document.
 *
 * These are jQuery events, so to listen for them you do something like this:
 *    $(DocumentManager).on("eventname", handler);
 */
define(function(require, exports, module) {

    var ProjectManager      = require("ProjectManager")
    ,   PreferencesManager  = require("PreferencesManager");

    /**
     * Unique PreferencesManager clientID
     */
    var PREFERENCES_CLIENT_ID = "com.adobe.brackets.DocumentManager";

    /**
     * @constructor
     * A single editable document, e.g. an entry in the working set list. Documents are unique per
     * file, so it IS safe to compare them with '==' or '==='.
     * @param {!FileEntry} file  The file being edited. Need not lie within the project.
     * @param {!CodeMirror} editor  Optional. The editor that will maintain the document state (current text
     *          and undo stack). It is assumed that the editor text has already been initialized
     *          with the file's contents. The editor may be null when the working set is restored
     *          at initialization.
     */
    function Document(file, editor) {
        if (!(this instanceof Document)) {  // error if constructor called without 'new'
            throw new Error("Document constructor must be called with 'new'");
        }
        if (getDocumentForFile(file) != null) {
            throw new Error("Creating a document + editor when one already exists, for: " + file);
        }
        
        this.file = file;
        this._setEditor(editor);
    }
    
    /**
     * The FileEntry for the document being edited.
     * @type {!FileEntry}
     */
    Document.prototype.file = null;
    
    /**
     * Whether this document has unsaved changes or not.
     * When this changes on any Document, DocumentManager dispatches a "dirtyFlagChange" event.
     * @type {boolean}
     */
    Document.prototype.isDirty = false;
    
    /**
     * @private
     * NOTE: this is actually "semi-private"; EditorManager also accesses this field. But no one
     * other than DocumentManager and EditorManager should access it.
     * TODO: we should close on whether private fields are declared on the prototype like this (vs.
     * just set in the constructor).
     * @type {!CodeMirror}
     */
    Document.prototype._editor = null;

    /**
     * @private
     * Initialize the editor instance for this file.
     */
    Document.prototype._setEditor = function(editor) {
        if (editor === undefined) {
            return;
        }
        
        this._editor = editor;
        
        // Dirty-bit tracking
        editor.setOption("onChange", this._updateDirty.bind(this));
        this._savedUndoPosition = editor.historySize().undo;   // should always be 0, but just to be safe...
    }
    
    /**
     * @private
     * TODO: we should close on whether private fields are declared on the prototype like this
     * @type {number}
     */
    Document.prototype._savedUndoPosition = 0;
    
    /**
     * @return {string} The editor's current contents; may not be saved to disk yet.
     */
    Document.prototype.getText = function() {
        return this._editor.getValue();
    }
    
    /**
     * @private
     */
    Document.prototype._updateDirty = function() {
        // If we've undone past the undo position at the last save, and there is no redo stack,
        // then we can never get back to a non-dirty state.
        var historySize = this._editor.historySize();
        if (historySize.undo < this._savedUndoPosition && historySize.redo == 0) {
            this._savedUndoPosition = -1;
        }
        var newIsDirty = (this._editor.historySize().undo != this._savedUndoPosition);
        
        if (this.isDirty != newIsDirty) {
            this.isDirty = newIsDirty;
            
            // Dispatch event
            $(exports).triggerHandler("dirtyFlagChange", this);
            
            // If file just became dirty, add it to working set (if not already there)
            if (newIsDirty)
                addToWorkingSet(this);
        }
    }
    
    /** Marks the document not dirty. Should be called after the document is saved to disk. */
    Document.prototype.markClean = function() {
        this._savedUndoPosition = this._editor.historySize().undo;
        this._updateDirty();
    }
    
    /* (pretty toString(), to aid debugging) */
    Document.prototype.toString = function() {
        return "[Document " + this.file.fullPath + " " + (this.isDirty ? "(dirty!)" : "(clean)") + "]";
    }
    
    
    
    /**
     * @private
     * @see DocumentManager.getCurrentDocument()
     */
    var _currentDocument = null;
    
    /**
     * Returns the Document that is currently open in the editor UI. May be null.
     * When this changes, DocumentManager dispatches a "currentDocumentChange" event.
     * @return {?Document}
     */
    function getCurrentDocument() {
        return _currentDocument;
    }
    
    /**
     * If the given file is 'open' for editing, returns its Document. Else returns null. "Open for
     * editing" means either the file is in the working set, and/or the file is currently open in
     * the editor UI.
     * @param {!FileEntry} fileEntry
     * @return {?Document}
     */
    function getDocumentForFile(fileEntry) {
        if (_currentDocument && _currentDocument.file.fullPath == fileEntry.fullPath)
            return _currentDocument;
        
        var wsIndex = _findInWorkingSet(fileEntry);
        if (wsIndex != -1)
            return _workingSet[wsIndex];
        
        return null;
    }
    
    
    /**
     * @private
     * @see DocumentManager.getWorkingSet()
     */
    var _workingSet = [];
    
    /**
     * Returns an ordered list of items in the working set. May be 0-length, but never null.
     *
     * When a Document is added this list, DocumentManager dispatches a "workingSetAdd" event.
     * When a Document is removed from list, DocumentManager dispatches a "workingSetRemove" event.
     * To listen for ALL changes to this list, you must listen for both events.
     *
     * Which items belong in the working set is managed entirely by DocumentManager. Callers cannot
     * (yet) change this collection on their own.
     *
     * @return {Array.<Document>}
     */
    function getWorkingSet() {
        return _workingSet;
        // TODO: return a clone to prevent meddling?
    }
    
    /**
     * Adds the given document to the end of the working set list, if it is not already in the list.
     * Does not change which document is currently open in the editor.
     * @param {!Document} document
     */
    function addToWorkingSet(document) {
        // If doc is already in working set, do nothing
        if (_findInWorkingSet(document.file) != -1)
            return;
        
        // Add
        _workingSet.push(document);
        
        // Dispatch event
        $(exports).triggerHandler("workingSetAdd", document);
    }
    
    /**
     * Removes the given document from the working set list, if it was in the list. Does not change
     * the editor even if this document is the one currently open;.
     * @param {!Document} document
     */
    function _removeFromWorkingSet(document) {
        // If doc isn't in working set, do nothing
        var index = _findInWorkingSet(document.file);
        if (index == -1)
            return;
        
        // Remove
        _workingSet.splice(index, 1);
        
        // Dispatch event
        $(exports).triggerHandler("workingSetRemove", document);
    }
    
    /**
     * @param {!FileEntry} fileEntry
     */
    function _findInWorkingSet(fileEntry) {
        for (var i = 0; i < _workingSet.length; i++) {
            if (_workingSet[i].file.fullPath == fileEntry.fullPath)
                return i;
        }
        return -1;
    }
    
    
    /**
     * Displays the given file in the editor pane. May also add the item to the working set list.
     * This changes the value of getCurrentDocument(), which will trigger listeners elsewhere in the
     * UI that in turn do things like update the selection in the file tree / working set UI.
     * 
     * @param {!Document} document  The document whose editor should be shown. May or may not
     *      already be in the working set.
     */
    function showInEditor(document) {
        // If this file is already in editor, do nothing
        if (_currentDocument == document)
            return;
        
        // If file not within project tree, add it to working set right now (don't wait for it to
        // become dirty)
        if (! ProjectManager.isWithinProject(document.file.fullPath)) {
           addToWorkingSet(document);
        }
        
        // Make it the current document
        _currentDocument = document;
        $(exports).triggerHandler("currentDocumentChange");
        // (this event triggers EditorManager to actually switch editors in the UI)
    }
    
    /** Closes the currently visible document, if any */
    function _clearEditor() {
        // If editor already blank, do nothing
        if (_currentDocument == null)
            return;
        
        // Change model & dispatch event
        _currentDocument = null;
        $(exports).triggerHandler("currentDocumentChange");
        // (this event triggers EditorManager to actually clear the editor UI)
    }
    
    
    /**
     * Closes the given document (which may or may not be the current document in the editor UI, and
     * may or may not be in the working set). Discards any unsaved changes if isDirty - it is
     * expected that the UI has already confirmed with the user before calling us.
     *
     * This will select a different file for editing if the document was the current one (if possible;
     * in some cases, the editor may be left blank instead). This will also remove the doc from the
     * working set if it was in the set.
     *
     * @param {!Document} document
     */
    function closeDocument(document) {
        // If this was the current document shown in the editor UI, we're going to switch to a
        // different document (or none if working set has no other options)
        if (_currentDocument == document) {
            var wsIndex = _findInWorkingSet(document.file);
            
            // Decide which doc to show in editor after this one
            var nextDocument;
            if (wsIndex == -1) {
                // If doc wasn't in working set, use bottommost working set item
                if (_workingSet.length > 0) {
                    nextDocument = _workingSet[ _workingSet.length  - 1 ];
                }
                // else: leave nextDocument null; editor area will be blank
            } else {
                // If doc was in working set, use item next to it (below if possible)
                if (wsIndex < _workingSet.length - 1) {
                    nextDocument = _workingSet[wsIndex + 1];
                } else if (wsIndex > 0) {
                    nextDocument = _workingSet[wsIndex - 1];
                }
                // else: leave nextDocument null; editor area will be blank
            }
            
            // Switch editor to next document (or blank it out)
            if (nextDocument)
                showInEditor(nextDocument);
            else
                _clearEditor();
        }
        
        // (Now we're guaranteed that the current document is not the one we're closing)
        console.assert(_currentDocument != document);
        
        // Remove closed doc from working set, if it was in there
        // This happens regardless of whether the document being closed was the current one or not
        _removeFromWorkingSet(document);
        
        // Note: EditorManager will dispose the closed document's now-unneeded editor either in
        // response to the editor-swap call above, or the _removeFromWorkingSet() call, depending on
        // circumstances. See notes in EditorManager for more.
    }
    
    /**
     * @private
     * Preferences callback. Saves the document file paths for the working set.
     */
    function _savePreferences(storage) {
        // save the working set file paths
        var files       = []
        ,   isActive    = false
        ,   workingSet  = getWorkingSet()
        ,   currentDoc  = getCurrentDocument();

        workingSet.forEach(function(value, index) {
            // flag the currently active editor
            isActive = (value === currentDoc);

            files.push({
                file: value.file.fullPath,
                active: isActive
            });
        });

        storage.files = files;
    }
    
    /**
     * @private
     * Initializes the working set.
     */
    function _init() {
        var prefs       = PreferencesManager.getPreferences(PREFERENCES_CLIENT_ID);

        if (prefs.files === undefined) {
            return;
        }

        var projectRoot = ProjectManager.getProjectRoot()
        ,   filesToOpen = []
        ,   activeFile;

        // in parallel, check if files exist
        // TODO (jasonsj): delay validation until user requests the editor (like Eclipse)?
        //                 e.g. A file to restore no longer exists. Should we silently ignore
        //                 it or let the user be notified when they attempt to open the Document?
        var result = (function() {
            var deferred        = new $.Deferred();
            var fileCount       = prefs.files.length
            ,   responseCount   = 0;

            function next() {
                responseCount++;

                if (responseCount == fileCount) {
                    deferred.resolve();
                }
            };

            prefs.files.forEach(function(value, index) {
                // check if the file still exists
                projectRoot.getFile(value.file, {}
                    , function(fileEntry) {
                        // maintain original sequence
                        filesToOpen[index] = fileEntry;

                        if (value.active) {
                            activeFile = fileEntry;
                        }

                        next();
                    }
                    , function(error) {
                        filesToOpen[index] = null;
                        next();
                    }
                );
            });

            return deferred;
        })();

        result.done(function() {
            var activeDoc
            ,   doc;

            // Add all existing files to the working set
            filesToOpen.forEach(function(value, index) {
                if (value) {
                    doc = new Document(value);
                    addToWorkingSet(doc);

                    if (value === activeFile) {
                        activeDoc = doc;
                    }
                }
            });

            // Initialize the active editor
            if (activeDoc === null) {
                activeDoc = _workingSet[0];
            }

            if (activeDoc != null) {
                showInEditor(activeDoc);
            }
        });
    }

    // Define public API
    exports.Document = Document;
    exports.getCurrentDocument = getCurrentDocument;
    exports.getDocumentForFile = getDocumentForFile;
    exports.getWorkingSet = getWorkingSet;
    exports.showInEditor = showInEditor;
    exports.addToWorkingSet = addToWorkingSet;
    exports.closeDocument = closeDocument;
    

    // Register preferences callback
    PreferencesManager.addPreferencesClient(PREFERENCES_CLIENT_ID, _savePreferences, this);

    // Initialize after ProjectManager is loaded
    $(ProjectManager).on("initializeComplete", function(event, projectRoot) {
        _init();
    });
});
