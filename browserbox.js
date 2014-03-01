/* jshint browser: true */
/* global define: false, imap: false, specialUse: false */

// AMD shim
(function(root, factory) {

    "use strict";

    if (typeof define === "function" && define.amd) {
        define([
            "./lib/imap",
            "./lib/specialUse",
            "./bower_components/utf7/utf7"
            ], factory);
    } else {
        root.browserbox = factory(imap, specialUse);
    }

}(this, function(imap, specialUse, utf7) {

    "use strict";

    function BrowserBox(host, port, options){
        this.options = options || {};
        this.client = imap(host, port);
        this.capability = [];
        this.serverId = null;

        this._established = false;

        this._init();
    }

    BrowserBox.prototype._init = function(){
        this.client.onlog = (function(type, payload){
            this.onlog(type, payload);
        }).bind(this);

        this.client.onerror = (function(err){
            this.onerror(err);
        }).bind(this);

        this.client.onclose = (function(){
            this.onclose();
        }).bind(this);

        this.client.setHandler("capability", function(response, next){
            this.capability = [].concat(response && response.attributes || []).map(function(capa){
                return (capa.value || "").toString().toUpperCase().trim();
            });

            next();
        });

        this.client.setHandler("ok", (function(response, next){
            this._processResponseCode(response);
            next();
        }).bind(this));

        this.client.onready = (function(){
            clearTimeout(this._connectionTimeout);

            this.onlog("session", "Connection established");

            this.checkCapability((function(){

                this.updateId(this.options.id, (function(){
                    if(this.options.auth){
                        this.login(this.options.auth.user, this.options.auth.pass, (function(err){
                            if(err){
                                this.onlog("auth", "Authentication failed");
                                this.onlog("error", err.message);
                                this.onerror(new Error(err.message));
                                this.exec("LOGOUT");
                                return;
                            }
                            this.onauth();
                        }).bind(this));
                    }else{
                        this.exec("LOGOUT");
                    }

                }).bind(this));
            }).bind(this));
        }).bind(this);
    };

    BrowserBox.prototype.connect = function(){
        clearTimeout(this._connectionTimeout);
        this._connectionTimeout = setTimeout(this._timeout, 60 * 1000);
        this.client.connect();
    };

    BrowserBox.prototype.onlog = function(){};
    BrowserBox.prototype.onerror = function(){};
    BrowserBox.prototype.onclose = function(){};
    BrowserBox.prototype.onauth = function(){};

    BrowserBox.prototype._onClose = function(){
        this.onclose();
    };

    BrowserBox.prototype._timeout = (function(){
        this.onerror(new Error("Timeout creating connection to the IMAP server"));
        this.client._destroy();
    }).bind(this);

    BrowserBox.prototype._processResponseCode = function(response){
        if(response){
            if(response.capability){
                this.capability = response.capability;
            }

            if(response.code == "ALERT" && response.humanReadable){
                this.onlog("alert", response.humanReadable);
            }
        }
    };

    // Macros

    BrowserBox.prototype.checkCapability = function(forced, callback){
        if(!callback && typeof forced == "function"){
            callback = forced;
            forced = undefined;
        }

        // skip request, if not forced update and capabilities are already loaded
        if(!forced && this.capability.length){
            return callback(null, false);
        }

        this.exec("CAPABILITY", function(err, response, next){
            next();

            if(err){
                callback(err);
            }else{
                callback(null, true);
            }
        });
    };

    BrowserBox.prototype.listNamespaces = function(callback){
        if(this.capability.indexOf("NAMESPACE") < 0){
            return callback(null, false);
        }

        this.exec("NAMESPACE", "NAMESPACE", (function(err, response, next){
            next();

            if(err){
                return callback(err);
            }

            return callback(null, this._parseNAMESPACE(response));
        }).bind(this));
    };

    BrowserBox.prototype.login = function(username, password, callback){
        this.exec({
            command: "login",
            attributes: [username, password]
        }, "capability", (function(err, response, next){
            next();

            var capabilityUpdated = false;

            if(err){
                return callback(err);
            }

            // update post-auth capabilites
            if(response.capability && response.capability.length){
                // capabilites were listed with the OK [CAPABILITY ...] response
                this.capability = [].concat(response.capability || []);
                capabilityUpdated = true;
                callback(null, true);
            }else if(response.payload && response.payload.CAPABILITY && response.payload.CAPABILITY.length){
                // capabilites were listed with * CAPABILITY ... response
                this.capability = [].concat(response.payload.CAPABILITY.pop().attributes || []).map(function(capa){
                    return (capa.value || "").toString().toUpperCase().trim();
                });
                capabilityUpdated = true;
                callback(null, true);
            }else{
                // capabilities were not automatically listed, reload
                this.checkCapability(true, function(err){
                    if(err){
                        callback(err);
                    }else{
                        callback(null, true);
                    }
                });
            }
        }).bind(this));
    };

    // See http://tools.ietf.org/html/rfc2971#section-3.3 for values
    BrowserBox.prototype.updateId = function(id, callback){
        if(this.capability.indexOf("ID") < 0){
            return callback(null, false);
        }

        var attributes = [];
        if(id){
            if(typeof id == "string"){
                id = {
                    name: id
                };
            }
            Object.keys(id).forEach(function(key){
                attributes.push(key);
                attributes.push(id[key]);
            });
        }else{
            attributes.push(null);
        }

        this.exec({command: "ID", attributes: attributes}, "ID", (function(err, response, next){
            next();

            if(err){
                return callback(err);
            }

            if(!response.payload || !response.payload.ID || !response.payload.ID.length){
                return callback(null, false);
            }

            this.serverId = {};

            var key;
            [].concat([].concat(response.payload.ID.shift().attributes || []).shift() || []).forEach((function(val, i){
                if(i % 2 === 0){
                    key = (val.value || "").toString().toLowerCase().trim();
                }else{
                    this.serverId[key] = (val.value || "").toString();
                }
            }).bind(this));

            this.onlog("server id", JSON.stringify(this.serverId));

            return callback(null, this.serverId);
        }).bind(this));
    };

    BrowserBox.prototype.listFolders = function(callback){
        this.exec({command: "LIST", attributes: ["", "*"]}, "LIST", (function(err, response, next){
            next();

            if(err){
                return callback(err);
            }

            var tree = {root: true, children: []};

            if(!response.payload || !response.payload.LIST || !response.payload.LIST.length){
                return callback(null, false);
            }

            response.payload.LIST.forEach((function(item){
                if(!item || !item.attributes || item.attributes.length < 3){
                    return;
                }
                var branch = this._ensurePath(tree, (item.attributes[2].value || "").toString(), (item.attributes[1].value).toString());
                branch.flags = [].concat(item.attributes[0] || []).map(function(flag){
                    return (flag.value || "").toString();
                });
                branch.listed = true;
                this._checkSpecialUse(branch);
            }).bind(this));

            this.exec({command: "LSUB", attributes: ["", "*"]}, "LSUB", (function(err, response, next){
                next();

                if(err){
                    return callback(null, tree);
                }

                if(!response.payload || !response.payload.LSUB || !response.payload.LSUB.length){
                    return callback(null, tree);
                }

                response.payload.LSUB.forEach((function(item){
                    if(!item || !item.attributes || item.attributes.length < 3){
                        return;
                    }
                    var branch = this._ensurePath(tree, (item.attributes[2].value || "").toString(), (item.attributes[1].value).toString());
                    [].concat(item.attributes[0] || []).map(function(flag){
                        flag = (flag.value || "").toString();
                        if(!branch.flags || branch.flags.indexOf(flag) < 0){
                            branch.flags = [].concat(branch.flags || []).concat(flag);
                        }
                    });
                    branch.subscribed = true;
                }).bind(this));

                callback(null, tree);
            }).bind(this));
        }).bind(this));
    };

    BrowserBox.prototype.exec = function(){
        var args = Array.prototype.slice.call(arguments),
            callback = args.pop();

        if(typeof callback != "function"){
            args.push(callback);
            callback = undefined;
        }

        args.push((function(response, next){
            var error = null;
            this._processResponseCode(response);
            if(["NO", "BAD"].indexOf((response && response.command || "").toString().toUpperCase().trim()) >= 0){
                error = new Error(response.humanReadable || "Error");
                if(response.code){
                    error.code = response.code;
                }
            }
            if(typeof callback == "function"){
                callback(error, response, next);
            }else{
                next();
            }
        }).bind(this));

        this.client.exec.apply(this.client, args);

        return this;
    };

    BrowserBox.prototype._parseNAMESPACE = function(response){
        var attributes,
            namespaces = false,
            parseNsElement = function(arr){
                return !arr ? null : [].concat(arr || []).map(function(ns){
                    return !ns || !ns.length ? null : {
                        prefix: ns[0].value,
                        delimiter: ns[1].value
                    };
                });
            };

        if(response.payload &&
            response.payload.NAMESPACE &&
            response.payload.NAMESPACE.length &&
            (attributes = [].concat(response.payload.NAMESPACE.pop().attributes || [])).length){

            namespaces = {
                personal: parseNsElement(attributes[0]),
                users: parseNsElement(attributes[1]),
                shared: parseNsElement(attributes[2])
            };
        }

        return namespaces;
    };

    BrowserBox.prototype._ensurePath = function(tree, path, delimiter){
        var names = path.split(delimiter), branch = tree, i, j, found;
        for(i = 0; i < names.length; i++){
            found = false;
            for(j = 0; j < branch.children.length; j++){
                if(branch.children[j].name == names[i]){
                    branch = branch.children[j];
                    found = true;
                    break;
                }
            }
            if(!found){
                branch.children.push({
                    name: utf7.imap.decode(names[i]),
                    delimiter: delimiter,
                    path: names.slice(0, i + 1).join(delimiter),
                    children: []
                });
                branch = branch.children[branch.children.length - 1];
            }
        }
        return branch;
    };

    BrowserBox.prototype._checkSpecialUse = function(folder){
        var type, specialFlags = ["\\All", "\\Archive", "\\Drafts", "\\Flagged", "\\Junk", "\\Sent", "\\Trash"];
        if(this.capability.indexOf("SPECIAL-USE")){
            if(!folder.flags || !folder.flags.length){
                return false;
            }
            for(var i = 0, len = specialFlags.length; i < len; i++){
                if(folder.flags.indexOf(specialFlags[i]) >= 0){
                    type = specialFlags[i];
                    break;
                }
            }
        }else{
            if((type = specialUse(folder.name))){
                folder.flags = [].concat(folder.flags || []).concat(name);
            }
        }
        if(!type){
            return false;
        }

        folder.specialUse = type.substr(1).toLowerCase();
        return type;
    };

    return function(host, port, options){
        return new BrowserBox(host, port, options);
    };
}));
