"use strict";

const async = require('async');
const bucketLists = require("../testdata/vault.json").bucketLists;
const Bucket = require('../bucket_mem.js');

let services = {};


 services.getBucketList = function(accessKey, callback){
	var result = bucketLists[accessKey];
	if(!result){
		return callback("No user data found");
	}
	return callback(null, result);
};

services.bucketExists = function(bucketname, cb) {
	for(let key in bucketLists){
		var userBuckets = bucketLists[key].bucketList;
		for(let i=0; i < userBuckets.length; i++){
			if(userBuckets[i].name === bucketname){
				return cb(null, true);
			}
		}
	}
	return cb(null, false);
};


services.objectExists = function(bucketname, objectKey, cb) {
	for(let key in bucketLists){
		var userBuckets = bucketLists[key].bucketList;
		for(let i=0; i < userBuckets.length; i++){
			if(userBuckets[i].name === bucketname){
				if(userBuckets[i].objects.indexOf(objectKey) > -1){
					return cb(null, true)
				}
			}
		}
	}
	return cb(null, false);
};

services.createBucket = function(bucketname, accessKey, region, callback) {
	_bucketExists(bucketname, function(exists) {
		if(exists) {
			return callback('Bucket already exists', null);
		}
		var userBuckets = bucketLists[accessKey].bucketList;
		var creationDate = new Date();
		userBuckets.push({
			name: bucketname,
			creationDate: creationDate.toISOString()
		});
		return callback(null,'Bucket created')
	});
};

services.isUserAuthorized = function(accessKey, bucketname, objectKey, isUserAuthorizedCallback) {
	var userInfo = bucketLists[accessKey];
	if(!userInfo){
		return isUserAuthorizedCallback(null, false);
	};
	var userBuckets = userInfo["bucketList"];

	for(let i=0; i<userBuckets.length; i++){
		if(userBuckets[i].name === bucketname){
			if(objectKey){
				if(userBuckets[i].objects.indexOf(objectKey) > -1){
					return isUserAuthorizedCallback(null, true);
				}
			}
			return isUserAuthorizedCallback(null, true);
		}
	}
	return isUserAuthorizedCallback(null, false);
};

// Generalized function to check whether a bucket exists and whether the given user has access.  
// For this implementation, authorization for all types of requests are collapsed into general authorization.
// The vault endpoints will have to deal with providing appropriate authorization checks for get versus put, etc.


services.bucketExistsandUserAuthorized = function(accessKey, bucketname, vaultGetResourceCallback) {

	_bucketExists(bucketname, function(exists) {
		if(!exists){
			//If bucket does not exist return status code 404
			return vaultGetResourceCallback(404)
		}
		//If bucket exists, check if this user as access to it
		_isUserAuthorized(accessKey, bucketname, function(is_authorized) {

			if(is_authorized){
				return vaultGetResourceCallback(200);
			}
			return vaultGetResourceCallback(403);
		});
	});
};

/**
 * Called by services.dataStore to actually put the key and value in the datastore
 * @param {object} ds - in memory datastore
 * @param {string} key - object key
 * @param {string} value - object value (request.post)
 * @param {function} callback - callback to services.dataStore
 */

services.putDataStore = function(ds, key, value, callback) {
	//In memory implementation
	ds.key = value;
	let location = key;
	callback(null, location);
}

/**
 * Checks whether resource exists and the user is authorized
 * @param {object} params - custom built object containing resource name, type, access key etc.
 * @param {function} cb - callback containing result for the next task
 */
services.metadataValidateAuthorization = function(params, cb) {
	let store = params.metastore;
	let bucketUID = params.bucketUID;
	let objectUID = params.objectUID;

	if(store[bucketUID] === undefined){
		return cb("Bucket does not exist");
	}

	let bucket = store[bucketUID];

	//For now, user is authorized if they are bucket owner.  In future implementation
	//will parse xml permissions more particularly.  
	if(bucket.owner === params.accessKey){
		if(bucket.keyMap[objectUID]){
			return cb(null, bucket, 'object exists');
		}
		return cb(null, bucket, null);
	}
	return cb("Action not permitted", null, null);

};



/**
 * Stores object and responds back with location and storage type
 * @param {object} params [custom built object containing resource name, resource body, type, access key etc.]
 * @param {function} [cb] [callback containing result for the next task]
 */
services.dataStore = function(bucket, objectExistsRes, ds, params, cb) {
	if(params.headers['content-md5']){
		if(params.headers['content-md5'] !== params.contentMD5){
			cb("Content-MD5 is invalid", null, null, null);
		}
	}

	let key = params.objectUID;
	this.putDataStore(ds, key, params.value, function(err, location){
		if(err){
			cb(err, null, null, null, null);
		}
		if(location) {
			return cb(null, bucket, objectExistsRes, location);
		}
		return cb(null, bucket, null, null);
	});

}

/**
 * Stores object location, custom headers, version etc.
 * @param {object} [params] [custom built object containing resource details.]
 * @param {function} [cb] [callback containing result for the next task]
 */

services.metadataStoreObject = function(bucket, objectExistsRes, location, metastore, params, cb) {
	let omVal;
	let objectUID = params.objectUID;
	if(objectExistsRes !== 'object exists'){
		omVal = {};
		omVal['Date'] = new Date();
	} else {
		omVal = bucket.keyMap[objectUID];
	}

	omVal['content-length'] = params.headers['content-length'];
	//confirm date format
	omVal['last-modified'] = new Date();
	omVal['content-md5'] = params.contentMD5;
	//Need to complete values
	omVal['x-amz-server-side-encryption'] = "";
	omVal['x-amz-server-version-id'] = "";
	omVal['x-amz-delete-marker'] = "";
	omVal['x-amz-storage-class'] = "";
	omVal['x-amz-website-redirect-location'] = "";
	omVal['x-amz-server-side-encryption-aws-kms-key-id'] = "";
	omVal['x-amz-server-side-encryption-customer-algorithm'] = "";
	omVal['location'] = location;

	for(let k in params.metaHeaders){
		omVal.k = params.metaHeaders.k;
	}

	bucket.PUTObject(params.objectUID, omVal, function (err) {
		if(err) {
			return cb(err, null);
		}
		return cb(null, params.contentMD5);
	});
	
};


/**
 * Checks whether user is authorized to create a bucket and whether the bucket already exists.  
 * If user is authorized and bucket does not already exist, bucket is created and saved in metastore
 * along with metadata provided with request.
 * @param {string} accessKey - user's access key
 * @param {string} bucketUID - unique identifier for bucket
 * @param {object} headers - request headers
 * @param {string} locationConstraint - locationConstraint provided in request body xml (if provided)
 * @param {object} metastore - global metastore
 * @param {function} callback - callback to bucketPut
 */

services.metadataStoreBucket = function(accessKey, bucketUID, headers, locationConstraint, metastore, callback) {

	async.waterfall([
        function(next){
        	//TODO Check user policies to see if user is authorized to create a bucket
	        if(metastore[bucketUID] !== undefined){
	          next("Bucket already exists", null);
	        }
	        next();
        },
        function(next){
        	let bucket = new Bucket();
        	bucket.owner = accessKey;

        	if(locationConstraint !== undefined) {
        		bucket.locationConstraint = locationConstraint;
        	}

        	if(headers['x-amz-acl']){
        		bucket.acl = headers['x-amz-acl'];
        	}

        	if(headers['x-amz-grant-read']){
        		bucket.acl['x-amz-grant-read'] = headers['x-amz-grant-read'];
        	}

        	if(headers['x-amz-grant-write']){
        		bucket.acl['x-amz-grant-write'] = headers['x-amz-grant-write'];
        	}

        	if(headers['x-amz-grant-read-acp']){
        		bucket.acl['x-amz-grant-read-acp'] = headers['x-amz-grant-read-acp'];
        	}

        	if(headers['x-amz-grant-write-acp']){
        		bucket.acl['x-amz-grant-write-acp'] = headers['x-amz-grant-write-acp'];
        	}

        	if(headers['x-amz-grant-full-control']){
        		bucket.acl['x-amz-grant-full-control'] = headers['x-amz-grant-full-control'];
        	}

        	metastore[bucketUID] = bucket;
        	next(null, "Bucket created");
        }
    ], function (err, result) {
        console.log("err in callback", err);
    	callback(err, result); 
    });


};

module.exports = services;