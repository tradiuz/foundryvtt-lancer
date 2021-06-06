import { EntryType, LiveEntryTypes, RegEntry, RegEntryTypes } from "machine-mind";
import { is_actor_type, LancerActor, LancerActorType, LancerActorTypes } from "../actor/lancer-actor";
import { LANCER } from "../config";
import { LancerItem, LancerItemType } from "../item/lancer-item";
import type { FoundryFlagData, FoundryRegNameParsed } from "./foundry-reg";
import { get_pack_id } from "./helpers";

const lp = LANCER.log_prefix;

// The associated entity to a given entry type. Type's a lil complex, but we need it to get things correct between abstracters that take items vs actors
// tl;dr maps entrytype to LancerItem or LancerActor
// export type EntFor<T extends EntryType & (LancerItemType | LancerActorType) > = T extends LancerItemType ? LancerItem<T> : (T extends LancerActorType ? LancerActor<T> : never);
export type EntFor<T extends EntryType> = T extends LancerItemType
  ? LancerItem<T>
  : T extends LancerActorType
  ? LancerActor<T>
  : never;

export interface GetResult<T extends LancerItemType | LancerActorType> {
  data: RegEntryTypes<T>;
  entity: EntFor<T>;
  id: string; // only truly necessary on enums, but still convenient
  type: T; // same
}

/**
 * Converts an entity into an item suitable for calling .create/.update/whatver with.
 * Specifically,
 * - creates the "data" by .save()ing the entity
 * - augments the data with anything in our top_level_data
 * - includes an id appropriate to the item. This will allow for bulk .update()s, and has no effect on .create()s
 *  + Note that this ID is taken from the MM ent, not the original entity. This is because some techniques like insinuation rely on manually altering Registry info to propagate ref changes
 */
function as_document_blob<T extends EntryType>(ent: LiveEntryTypes<T>): any {
  let flags = ent.Flags as FoundryFlagData<T>;

  // Set name from changed data. Prioritize a changed top level name over a changed ent name
  if (flags.top_level_data.name && flags.top_level_data.name != flags.orig_doc_name) {
    // Override ent data with top level
    ent.Name = flags.top_level_data.name;
  } else if (ent.Name && ent.Name != flags.orig_doc_name) {
    // Override top level with ent data
    flags.top_level_data.name;
  }

  // Combine saved data with top level data
  let result = mergeObject(
    {
      _id: ent.RegistryID,
      data: ent.save(),
    },
    flags.top_level_data
  );

  return result;
}


/**
 * A FoundryRegNameParsed resolved into specific collections
 */
export type ResolvedRegArgs = {
  item_collection?: null | (() => Promise<any>); // If provided we use this item collection. Might be an inventory, hence the asynchronous lookup
  actor_collection?: null | any; // If provided we use this actor collection. If not provided, we use the token collection and map to the appropriate actor
  token_collection?: null | any; // If provided we use this token collection to fetch actors. Corresponds to a single Scene
}

export abstract class EntityCollectionWrapper<T extends EntryType> {
  // Create an item and return a reference to it
  abstract create_many(items: RegEntryTypes<T>[]): Promise<GetResult<T>[]>; // Return id
  // Update the specified item of type T
  abstract update(items: Array<LiveEntryTypes<T>>): Promise<any>;
  // Retrieve the specified item of type T, or yield null if it does not exist
  abstract get(id: string): Promise<GetResult<T> | null>;
  // Delete the specified item
  abstract destroy(id: string): Promise<any>;
  // List items matching specific query items, including id for reference
  abstract query(query_ob: {[key: string]: any}): Promise<GetResult<T>[]>;
  // List all items, including id for reference
  abstract enumerate(): Promise<GetResult<T>[]>;
}

// 0.8: Should return CompendiumCollection. Lists all compendiums of specified document type that aren't in our standard id set


export class NuWrapper<T extends EntryType> extends EntityCollectionWrapper<T> {
  // Need this to filter results by type/know what we're returning
  entry_type: T;

  // This is our document type that we'll use for creation/destruction
  // doc_type: typeof Actor | typeof Item;

  // Our collection. Can be a world collection, embedded collection, or compendiumcollection
  // Note: technically, "scene_tokens" still uses the game.actors collection
  // Has .documentClass, which we use to call updateDocuments etc
  // (Sometimes) has .parent. If we have an actor, will have .parent
  collection: Promise<any>; // 0.8 Should be EmbeddedCollection | WorldCollection, and can be of Items or Actors

  // Our scene, if any. If provided, we use special procedures for getting data to properly fetch from here
  // Note: we ONLY set this if we are src type "scene", since "scene_token" doesn't really care
  // Scene and pack will never both be set
  scene: any | null; // 0.8 Should be `Scene` once the type is fixed

  // Our pack, if any. Should only ever be one, because
  // - If we have a parent, it will be from a single pack and thus all items in our purview will also be from that singular pack
  // - If we are core, in spite of the numerous packs we have but a single one that actually is associated with this entry type
  // - If we are not core, then we are exclusively associated with a single custom compendium pack name
  // Scene and pack will never both be set
  pack: string | null; 

  private static async lookup_collection<G extends EntryType>(entry_type: G, cfg: FoundryRegNameParsed): Promise<any> {
      if(cfg.src == "comp_actor") {
        // Get our desired pack
        // @ts-ignore 0.8
        let actor_pack = game.packs.get(cfg.comp_id);
        if(!actor_pack) {
          throw new Error("Couldn't find pack " + cfg.comp_id); 
        }

        // Get our desired actor document from the pack
        // @ts-ignore 0.8
        actor_pack.getDocument(cfg.token_id).then(actor => {
          if(!actor) {
            throw new Error("Pack " + cfg.comp_id + " didn't have actor with id " + cfg.actor_id);
          }

          // Victory! Return the actors item collection
          return actor.items;
        });

      } else if(cfg.src == "game_actor") {
        // Lookup the actor
        let actor = game.actors.get(cfg.actor_id);
        if(!actor) {
          throw new Error("Couldn't find game actor " + cfg.actor_id);
        }

        // Success!
        return actor.items;
      } else if(cfg.src == "scene_token") {
        // Lookup scene
        let scene = game.scenes.get(cfg.scene_id);
        if(!scene) {
          throw new Error("Couldn't find scene " + cfg.scene_id);
        }

        // Lookup token in scene
        // @ts-ignore 0.8
        let token = scene.tokens.get(cfg.token_id);
        if(!token) {
          throw new Error("Couldn't find token " + cfg.token_id + " in scene " + cfg.scene_id);
        } 

        // Get actor from token
        if(!token.actor) {
          throw new Error(`Token ${cfg.token_id} has no actor`); // Possible, albeit unlikely, if tokens actor is delete
        }

        // Return the token actor. Success!
        return token.actor.items;
      } else if(cfg.src == "comp") {
        // Get the pack collection. 
        let pack = game.packs.get(cfg.comp_id);
        if(!pack) {
          throw new Error(`Pack ${cfg.comp_id} does not exist`);
        }
      } else if(cfg.src == "comp_core") {
        // Get the pack collection, derived from our type
        let comp_id = get_pack_id(entry_type);
        let pack = game.packs.get(comp_id);
        if(!pack) {
          throw new Error(`Core pack ${comp_id} does not exist`);
        }
      } else if(cfg.src == "game") {
        // Get the appropriate world collection
        if(is_actor_type(entry_type)) {
          return game.actors;
        } else {
          return game.items;
        }
      } else if(cfg.src == "scene") {
        // A bit weird, but we return game.actors
        // Separate logic will make sure that we update with the right parent
        return game.actors;
      }
  }

  constructor(type: T, cfg: FoundryRegNameParsed) {
    super();

    // Set type and doc type
    this.entry_type = type;

    // Resolve our pack
    if(cfg.src == "comp" || cfg.src == "comp_actor") {
      // Resolve from our core type pack primarily, but also give others!
      this.pack = cfg.comp_id
    } else if(cfg.src == "comp_core") {
      this.pack = get_pack_id(this.entry_type);
    } else {
      this.pack = null;
    }

    // Resolve our scene
    if(cfg.src == "scene") {
      this.scene = game.scenes.get(cfg.scene_id);
      if(!this.scene) {
        throw new Error(`Invalid scene id: "${cfg.scene_id}"`);
      }
    } else {
      this.scene = null;
    }

    // Resolve our collection as appropriate. Async to handle comp_actor cases
    this.collection = NuWrapper.lookup_collection(this.entry_type, cfg);
  }

  // Options to provide to document editing operations. 
  private async non_scene_opts(): Promise<any> { // 0.8 Should eventually be DocumentModificationContext
    // Attempt to resolve
    let collection = await this.collection;
    let parent = collection.parent; // Will give base actor

    if(parent) {
      return {
        parent,
        pack: this.pack 
      }
    } else {
      return {
        pack: this.pack
      }
    }
  }

  async create_many(reg_data: RegEntryTypes<T>[]): Promise<GetResult<T>[]> {
    // Creating tokens via this mechanism is forbidden, for the time being. 
    if(this.scene) {
      console.error("Creating tokens via registry is not yet supported");
      return [];
    }

    // Create the docs. Opts will properly put things in the right collection/actor/whatever
    // @ts-ignore 0.8
    let new_docs = ((await this.collection).documentClass.createDocuments(
      reg_data.map(d => ({
        type: this.entry_type,
        name: d.name,
        data: duplicate(d),
      })), await this.non_scene_opts())) as EntFor<T>[];

    // Return the reference
    return new_docs.map((item, index) => ({
      id: item.data._id,
      entity: item,
      type: this.entry_type,
      data: reg_data[index],
    }));
  }

  // Simple delegated call to <document class>.updateDocuments
  async update(items: Array<LiveEntryTypes<T>>): Promise<void> {
    //@ts-ignore 0.8
    return (await this.collection).documentClass.updateDocuments(items.map(as_document_blob), await this.non_scene_opts());
  }

  // Simple delegated call to <document class>.deleteDocuments
  async destroy(id: string): Promise<RegEntryTypes<T> | null> {
    //@ts-ignore .8
    return (await this.collection).documentClass.deleteDocuments([id], await this.non_scene_opts());
  }

  // Call a .get appropriate to our parent/pack/lack thereof
  async get(id: string): Promise<GetResult<T> | null> {
    let collection = await this.collection; 
    let fi: any; // Our found result

    // Getting item slightly different if we're a pack
    if(this.pack) {
      fi = await collection.getDocument(id); // Is a CompendiumCollection
    } else {
      // @ts-ignore 0.8
      fi = collection.get(id);
    } 

    // Check its type and return
    if (fi && fi.type == this.entry_type) {
      return {
        data: fi.data.data as RegEntryTypes<T>,
        entity: fi as EntFor<T>,
        id,
        type: this.entry_type,
      };
    } else {
      return null;
    }
  }

  // Call a .contents/getDocuments appropriate to our parent/container/whatever, then filter to match query
  async query(query_obj: {[key: string]: any}): Promise<GetResult<T>[]> {
    // If we are a pack must first call .getDocuments() to fetch all
    let collection = await this.collection;
    let all: any[];
    if(this.pack) {
      all = await collection.getDocuments({
        ...query_obj,
        type: this.entry_type
      });
    } else {
      all = collection.contents;
      // But we have to filter it ourselves - no getDocuments query here!
      all = all.filter(doc => {
        // First check entry type
        if(doc.type != this.entry_type) {
            return false; // Failure! Filter it out
        }

        // Check each k, v
        for(let [k,v] of Object.entries(query_obj)) {
          if(doc.data._source.data[k] != v) {
            return false; // Failure! Filter it out
          }
        }
        return true; // It's fine :)
      });
    }

    // Having retrieved all, just map to our GetResult format
    // @ts-ignore .8 Should be document
    return all.map((e: any) => ({
        id: (e.data as any)._id,
        data: e.data.data as RegEntryTypes<T>,
        entity: e as EntFor<T>,
        type: this.entry_type,
      }));
  }

  // Just query with no filter! ez
  enumerate(): Promise<GetResult<T>[]> {
    return this.query({});
  }
}



/********* COMPENDIUM CACHING **********/
// const COMPENDIUM_CACHE_TIMEOUT = 2 * 1000; // 20 seconds 


// Caches getContent() _as a map_ (wowee!). Idk if generating these maps are expensive but why tempt fate, lmao
/*
const PackContentMapCache = new FetcherCache(
  COMPENDIUM_CACHE_TIMEOUT,
  async (type: LancerItemType | LancerActorType) => {
    let pack = await get_pack(type);
    let data = await (pack as any).getDocuments();
    let map = new Map();
    for (let e of data) {
      map.set(e.id, e);
    }
    return map;
  }
);

// This wraps interfacing with above caches, but with better typing!
export async function cached_get_pack_map<T extends LancerItemType | LancerActorType>(
  type: T
): Promise<Map<string, T extends LancerItemType ? LancerItem<T> : T extends LancerActorType ? LancerActor<T> : never>> {
  console.log("Cache flushing should be triggered off of compendium CRUD hooks");
  return PackContentMapCache.fetch(type);
}

// Use this for incoming compendium updates, as we cannot really watch for them otherwise
export function invalidate_cached_pack_map<T extends EntryType>(type: T) {
  console.log("Flushed cache. Note that this was made faster for testing, and should be more of a 60 second interval thing: ", type);
  PackContentMapCache.flush(type);
}
*/